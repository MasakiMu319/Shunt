// Shunt Extension — browser agent platform over Helium
// JSON-RPC 2.0 over Native Messaging
// Methods: attach, detach, executeCdp, createTab, closeTab, screenshot,
//          click, type, scroll, getUserTabs, activateTab, getSession, finalizeTabs

// ═══════════════════════════════════════════════════════════════
// JSON-RPC Transport
// ═══════════════════════════════════════════════════════════════

let port = null;
let nextId = 1;
const pendingRequests = new Map(); // id => { resolve, reject, timer }

const REQUEST_TIMEOUT = 30000; // 30s for user-facing requests
const CDP_TIMEOUT = 10000;     // 10s per CDP command

function sendResponse(id, result) {
  if (port) port.postMessage({ jsonrpc: "2.0", result, id });
}

function sendError(id, code, message) {
  if (port) port.postMessage({ jsonrpc: "2.0", error: { code, message }, id });
}

function sendNotification(method, params) {
  if (port) port.postMessage({ jsonrpc: "2.0", method, params });
}

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

const attachedTabs = new Set();
const tabLocks = new Map();       // tabId => Promise chain
let tabGroupId = null;
let groupWindowId = null;         // which window the group is in

// ═══════════════════════════════════════════════════════════════
// Per-tab mutex
// ═══════════════════════════════════════════════════════════════

async function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    (err) => fn(err)
  );
  tabLocks.set(tabId, next);
  try {
    return await next;
  } finally {
    if (tabLocks.get(tabId) === next) {
      tabLocks.delete(tabId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Tab group management — lives in user's current active window
// ═══════════════════════════════════════════════════════════════

async function getOrCreateTabGroup(windowId) {
  // If group exists and is in this window, reuse it
  if (tabGroupId != null && groupWindowId === windowId) {
    try {
      await chrome.tabGroups.get(tabGroupId);
      return tabGroupId;
    } catch {
      // Group no longer exists, fall through
      tabGroupId = null;
      groupWindowId = null;
    }
  }

  // Create a new group in this window with an anchor tab
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
  const gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await chrome.tabGroups.update(gid, { collapsed: true, title: "agent-browser" });
  // Keep anchor tab — empty groups are auto-deleted
  tabGroupId = gid;
  groupWindowId = windowId;
  return gid;
}

// ═══════════════════════════════════════════════════════════════
// CDP helpers
// ═══════════════════════════════════════════════════════════════

function cdpSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("CDP timeout: " + method + " (" + CDP_TIMEOUT + "ms)")),
      CDP_TIMEOUT
    );
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function cdpGetTargets() {
  return new Promise((resolve, reject) => {
    chrome.debugger.getTargets((targets) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve({ targetInfos: targets });
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════
// Request handlers
// ═══════════════════════════════════════════════════════════════

async function h_createTab() {
  // Use user's current active window — like Codex
  const win = await chrome.windows.getLastFocused({ populate: false });
  const groupId = await getOrCreateTabGroup(win.id);

  const tab = await chrome.tabs.create({
    windowId: win.id,
    url: "about:blank",
    active: false,
  });

  await chrome.tabs.group({ tabIds: [tab.id], groupId });
  return { tabId: tab.id, windowId: win.id, url: "about:blank" };
}

async function h_closeTab(params) {
  const { tabId } = params;
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
      attachedTabs.delete(tabId);
    }
    try { await chrome.tabs.remove(tabId); } catch { /* ok */ }
    return { tabId };
  });
}

async function h_attach(params) {
  const { tabId } = params;
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) {
      return { tabId, alreadyAttached: true };
    }
    await chrome.debugger.attach({ tabId }, "1.3");
    attachedTabs.add(tabId);
    // Enable useful domains
    await cdpSendCommand(tabId, "Page.enable");
    await cdpSendCommand(tabId, "Network.enable");
    await cdpSendCommand(tabId, "Runtime.enable");
    return { tabId, attached: true };
  });
}

async function h_detach(params) {
  const { tabId } = params;
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) {
      try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
      attachedTabs.delete(tabId);
    }
    return { tabId };
  });
}

async function h_executeCdp(params) {
  const { tabId, method, params: cdpParams } = params;
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) {
      throw new Error("Tab " + tabId + " not attached. Call attach first.");
    }
    let result;
    if (method === "Target.getTargets") {
      result = await cdpGetTargets();
    } else {
      result = await cdpSendCommand(tabId, method, cdpParams);
    }
    return { tabId, method, result };
  });
}

async function h_screenshot(params) {
  const { tabId, format, quality, clip, fromSurface } = params || {};
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) {
      throw new Error("Tab " + tabId + " not attached.");
    }
    const p = { format: format || "png" };
    if (quality != null) p.quality = quality;
    if (clip) p.clip = clip;
    if (fromSurface != null) p.fromSurface = fromSurface;
    const result = await cdpSendCommand(tabId, "Page.captureScreenshot", p);
    return { tabId, data: result.data, format: p.format };
  });
}

async function h_click(params) {
  const { tabId, x, y, button, clickCount } = params;
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) {
      throw new Error("Tab " + tabId + " not attached.");
    }
    const args = {
      type: "mousePressed",
      x, y,
      button: button || "left",
      clickCount: clickCount || 1,
    };
    await cdpSendCommand(tabId, "Input.dispatchMouseEvent", args);
    args.type = "mouseReleased";
    await cdpSendCommand(tabId, "Input.dispatchMouseEvent", args);
    return { tabId, x, y };
  });
}

async function h_type(params) {
  const { tabId, text } = params;
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) {
      throw new Error("Tab " + tabId + " not attached.");
    }
    for (const ch of text) {
      await cdpSendCommand(tabId, "Input.dispatchKeyEvent", {
        type: "char",
        text: ch,
        unmodifiedText: ch,
      });
    }
    return { tabId };
  });
}

async function h_scroll(params) {
  const { tabId, x, y, deltaX, deltaY } = params;
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) {
      throw new Error("Tab " + tabId + " not attached.");
    }
    await cdpSendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: x || 0,
      y: y || 0,
      deltaX: deltaX || 0,
      deltaY: deltaY || 500,
    });
    return { tabId };
  });
}

async function h_getUserTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
    })),
  };
}

async function h_activateTab(params) {
  const { tabId } = params;
  // Only make tab active within its own window — don't steal focus
  await chrome.tabs.update(tabId, { active: true });
  return { tabId };
}


async function h_getSession() {
  return {
    groupWindowId,
    tabGroupId,
    attachedTabs: Array.from(attachedTabs),
  };
}

async function h_finalizeTabs(params) {
  const { keep } = params;
  const keepSet = new Set(keep || []);

  // Detach tabs not in keep list
  for (const tabId of attachedTabs) {
    if (!keepSet.has(tabId)) {
      await h_detach({ tabId });
    }
  }

  // Close agent tabs not in keep list (query by group)
  if (tabGroupId != null) {
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    for (const tab of tabs) {
      if (!keepSet.has(tab.id)) {
        try { await chrome.tabs.remove(tab.id); } catch { /* ok */ }
      }
    }
  }

  return { kept: Array.from(keepSet) };
}

// ═══════════════════════════════════════════════════════════════
// Handler router
// ═══════════════════════════════════════════════════════════════

const handlers = {
  createTab:     h_createTab,
  closeTab:      h_closeTab,
  attach:        h_attach,
  detach:        h_detach,
  executeCdp:    h_executeCdp,
  screenshot:    h_screenshot,
  click:         h_click,
  type:          h_type,
  scroll:        h_scroll,
  getUserTabs:   h_getUserTabs,
  activateTab:   h_activateTab,
  getSession:    h_getSession,
  finalizeTabs:  h_finalizeTabs,
};

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id == null) {
    // Notification — route to event listeners
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    sendError(id, -1, "Method not found: " + method);
    return;
  }
  try {
    const result = await handler(params);
    sendResponse(id, result);
  } catch (err) {
    sendError(id, -2, err.message || String(err));
  }
}

// ═══════════════════════════════════════════════════════════════
// CDP Event forwarding
// ═══════════════════════════════════════════════════════════════

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && attachedTabs.has(source.tabId)) {
    sendNotification("cdpEvent", {
      tabId: source.tabId,
      method,
      params,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Debugger detach (external: DevTools opened, tab crashed, etc.)
// ═══════════════════════════════════════════════════════════════

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    attachedTabs.delete(source.tabId);
    tabLocks.delete(source.tabId);
    sendNotification("debuggerDetached", {
      tabId: source.tabId,
      reason,
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Native Messaging connection
// ═══════════════════════════════════════════════════════════════

function connect() {
  try {
    port = chrome.runtime.connectNative("com.opensetsuna.shunt");

    port.onMessage.addListener((msg) => {
      handleRequest(msg).catch((err) => {
        console.error("shunt: handler error", err);
      });
    });

    port.onDisconnect.addListener(async () => {
      console.warn("shunt: native host disconnected");
      // Detach all debuggers
      for (const tabId of attachedTabs) {
        try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
      }
      attachedTabs.clear();
      tabLocks.clear();
      port = null;
      setTimeout(connect, 1000);
    });

    console.log("shunt: connected");
  } catch (err) {
    console.error("shunt: connect failed", err);
    setTimeout(connect, 5000);
  }
}

// ═══════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════

connect();
