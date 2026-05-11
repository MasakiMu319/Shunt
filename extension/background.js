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
// Tab group management — searches all windows; reuses or migrates
// ═══════════════════════════════════════════════════════════════

let anchorTabId = null;  // track the placeholder tab to prevent accidental deletion

async function getOrCreateTabGroup(windowId) {
  // 1. Fast path: in-memory cache hit — verify group still exists
  if (tabGroupId != null) {
    try {
      const group = await chrome.tabGroups.get(tabGroupId);
      // If group is in a different window than requested, migrate it
      if (group.windowId !== windowId) {
        await chrome.tabGroups.move(tabGroupId, { windowId, index: -1 });
      }
      groupWindowId = windowId;
      return tabGroupId;
    } catch {
      // Group deleted — null state and fall through to search
      tabGroupId = null;
      groupWindowId = null;
      anchorTabId = null;
    }
  }

  // 2. Search ALL windows for an existing "Shunt" group (handles
  //    service worker restarts, cross-window scenarios, etc.)
  const wins = await chrome.windows.getAll({ populate: true });
  for (const win of wins) {
    for (const tab of win.tabs ?? []) {
      if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
      try {
        const group = await chrome.tabGroups.get(tab.groupId);
        if (group && group.title === "Shunt") {
          tabGroupId = group.id;
          groupWindowId = group.windowId;
          // Track the anchor tab (pick any tab in the group as a placeholder)
          if (tab.url === "about:blank") anchorTabId = tab.id;
          // If group is in the wrong window, migrate it to the requested one
          if (group.windowId !== windowId) {
            await chrome.tabGroups.move(tabGroupId, { windowId, index: -1 });
            groupWindowId = windowId;
          }
          return tabGroupId;
        }
      } catch { /* group deleted, continue */ }
    }
  }

  // 3. Create new group with anchor tab in the requested window
  const tab = await chrome.tabs.create({ windowId, url: "about:blank", active: false });
  const gid = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await chrome.tabGroups.update(gid, { collapsed: true, title: "Shunt" });
  tabGroupId = gid;
  groupWindowId = windowId;
  anchorTabId = tab.id;
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
  // Protect the anchor tab — closing it would delete the entire group
  if (tabId === anchorTabId) {
    throw new Error("Cannot close the Shunt anchor tab. Use finalizeTabs to clean up the group.");
  }
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
    anchorTabId,
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
    anchorTabId,
  };
}

async function h_finalizeTabs(params) {
  const { keep } = params;
  const keepSet = new Set(keep || []);

  // Always protect the anchor tab — closing it would delete the entire group
  if (anchorTabId != null) {
    keepSet.add(anchorTabId);
  }

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
  ping:          h_ping,
};

// Notification handlers (one-way, no id)
function handleNotification(msg) {
  const { method, params } = msg;
  switch (method) {
    case "heartbeat":
      lastHeartbeat = Date.now();
      break;
    // Add more notification handlers here
  }
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id == null) {
    handleNotification(msg);
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
// Heartbeat — CLI sends periodic heartbeats; extension monitors timeout
// ═══════════════════════════════════════════════════════════════

const HEARTBEAT_NAME = "shunt-heartbeat";
const HEARTBEAT_CHECK_PERIOD = 10;  // seconds — check every 10s
const HEARTBEAT_GRACE     = 45;  // seconds — grace period before cleanup on first connect
const HEARTBEAT_TIMEOUT   = 35;  // seconds — cleanup if no heartbeat this long

let lastHeartbeat = Date.now();
let heartbeatArmed = false;

function startHeartbeat() {
  lastHeartbeat = Date.now();
  heartbeatArmed = true;
  chrome.alarms.create(HEARTBEAT_NAME, { periodInMinutes: HEARTBEAT_CHECK_PERIOD / 60 });
}

function stopHeartbeat() {
  heartbeatArmed = false;
  chrome.alarms.clear(HEARTBEAT_NAME);
}

async function cleanup(reason) {
  console.warn("shunt: cleanup —", reason);
  for (const tabId of attachedTabs) {
    try { await chrome.debugger.detach({ tabId }); } catch { /* ok */ }
  }
  attachedTabs.clear();
  tabLocks.clear();
}

// Connectivity check (simple round-trip, no side effects)
function h_ping() {
  return { ok: true };
}

// Heartbeat received from CLI via notification

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== HEARTBEAT_NAME || !heartbeatArmed) return;

  const elapsed = (Date.now() - lastHeartbeat) / 1000;

  // Grace period on first connect: CLI may still be starting up
  if (elapsed < HEARTBEAT_GRACE) return;

  if (elapsed > HEARTBEAT_TIMEOUT) {
    stopHeartbeat();
    await cleanup("heartbeat timeout");
    sendNotification("statusReport", {
      report: {
        nativeHost: "unreachable",
        connected: false,
        attachedTabs: [],
        attachedCount: 0,
      },
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
      console.warn("shunt: host diconnected, triggering cleanup");
      stopHeartbeat();
      await cleanup("native host disconnected");
      port = null;
      setTimeout(connect, 1000);
    });

    startHeartbeat();
    console.log("shunt: connected");
  } catch (err) {
    console.error("shunt: connect failed", err);
    setTimeout(connect, 5000);
  }
}

// ═══════════════════════════════════════════════════════════════
// Popup (chrome.runtime.onMessage)
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { id, method } = msg;
  if (id == null) { sendResponse(null); return false; }
  const handler = handlers[method];
  if (!handler) {
    sendResponse({ jsonrpc: "2.0", id, error: { code: -1, message: "Method not found: " + method } });
    return false;
  }
  handler(msg.params).then((result) => {
    sendResponse({ jsonrpc: "2.0", id, result });
  }).catch((err) => {
    sendResponse({ jsonrpc: "2.0", id, error: { code: -2, message: err.message || String(err) } });
  });
  return true; // async
});

// ═══════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════

connect();
