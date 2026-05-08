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
  // 1. Fast path: in-memory cache hit (same session, same window)
  if (tabGroupId != null && groupWindowId === windowId) {
    try {
      await chrome.tabGroups.get(tabGroupId);
      return tabGroupId;
    } catch {
      tabGroupId = null;
      groupWindowId = null;
    }
  }

  // 2. Search for existing agent-browser group in this window
  //    (handles service worker restart, window switch, etc.)
  const allTabs = await chrome.tabs.query({ windowId });
  for (const tab of allTabs) {
    if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
    try {
      const group = await chrome.tabGroups.get(tab.groupId);
      if (group && group.title === "Shunt") {
        tabGroupId = group.id;
        groupWindowId = windowId;
        return group.id;
      }
    } catch { /* group deleted, continue */ }
  }

  // 3. Create new group with anchor tab
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
  const gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await chrome.tabGroups.update(gid, { collapsed: true, title: "Shunt" });
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
    await cdpSendCommand(tabId, "DOM.enable");
    try { await cdpSendCommand(tabId, "Accessibility.enable"); } catch { /* optional */ }
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
    // Mouse move before click to position cursor
    await cdpSendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x, y, button: "none", buttons: 0, modifiers: 0,
    });
    const btn = button || "left";
    const btnMask = btn === "left" ? 1 : btn === "right" ? 2 : 4;
    const args = {
      type: "mousePressed",
      x, y,
      button: btn,
      buttons: btnMask,
      clickCount: clickCount || 1,
      modifiers: 0,
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

async function h_getStatus() {
  return {
    connected: true,
    nativeHost: port ? "connected" : "disconnected",
    attachedTabs: Array.from(attachedTabs),
    attachedCount: attachedTabs.size,
    groupWindowId,
    tabGroupId,
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
async function h_findElement(params) {
  const { tabId, text, selector } = params;
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) throw new Error("Tab " + tabId + " not attached.");

    let expression;
    if (text) {
      const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      expression = `(() => {
        const els = document.querySelectorAll("a,button,input,label,span,div,p,h1,h2,h3,h4,h5,h6,li,td,th");
        for (const el of els) {
          if (el.textContent && el.textContent.includes("${escaped}")) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              el.setAttribute("data-shunt-found", "true");
              return { x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height, tag: el.tagName, text: el.textContent.substring(0, 120) };
            }
          }
        }
        return null;
      })()`;
    } else if (selector) {
      const escaped = selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
      expression = `(() => {
        const el = document.querySelector("${escaped}");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        el.setAttribute("data-shunt-found", "true");
        return { x: r.left + r.width/2, y: r.top + r.height/2, width: r.width, height: r.height, tag: el.tagName, text: el.textContent?.substring(0, 120) || "" };
      })()`;
    } else {
      throw new Error("Must provide text or selector");
    }

    const result = await cdpSendCommand(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: false,
    });

    const el = result.result?.value || null;

    return { tabId, element: el };
  });
}

async function h_getPageText(params) {
  const { tabId, maxLength } = params || {};
  return withTabLock(tabId, async () => {
    if (!attachedTabs.has(tabId)) throw new Error("Tab " + tabId + " not attached.");
    const result = await cdpSendCommand(tabId, "Runtime.evaluate", {
      expression: "document.body?.innerText || ''",
      returnByValue: true,
    });
    let text = result.result?.value || '';
    const limit = maxLength || 10000;
    if (text.length > limit) text = text.substring(0, limit) + '...';
    return { tabId, text, truncated: text.length >= limit };
  });
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
  getStatus:     h_getStatus,
  finalizeTabs:  h_finalizeTabs,
  findElement:   h_findElement,
  getPageText:   h_getPageText,
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
