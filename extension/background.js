// Shunt Extension — browser agent platform over Helium
// JSON-RPC 2.0 over Native Messaging
// Methods: attach, detach, executeCdp, createTab, closeTab, screenshot,
//          click, type, scroll, getUserTabs, activateTab, getSession, finalizeTabs

// ═══════════════════════════════════════════════════════════════
// JSON-RPC Transport
// ═══════════════════════════════════════════════════════════════

let port = null;

const CDP_TIMEOUT = 10000; // 10s per CDP command

function sendResponse(id, result, responsePort = port) {
  if (responsePort && responsePort === port) {
    responsePort.postMessage({ jsonrpc: "2.0", result, id });
  }
}

function sendError(id, code, message, responsePort = port) {
  if (responsePort && responsePort === port) {
    responsePort.postMessage({ jsonrpc: "2.0", error: { code, message }, id });
  }
}

function sendNotification(method, params) {
  if (port) port.postMessage({ jsonrpc: "2.0", method, params });
}

// ═══════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════

const attachedTabs = new Set();
const tabLocks = new Map(); // tabId => Promise chain
let tabGroupId = null;
let groupWindowId = null; // which window the group is in

// ═══════════════════════════════════════════════════════════════
// Per-tab mutex
// ═══════════════════════════════════════════════════════════════

async function withTabLock(tabId, fn) {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev.then(
    () => fn(),
    (err) => fn(err),
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

let anchorTabId = null; // track the placeholder tab to prevent accidental deletion

let groupLock = Promise.resolve();

async function getOrCreateTabGroup(windowId) {
  return new Promise((resolve, reject) => {
    groupLock = groupLock.then(async () => {
      try {
        const gid = await getOrCreateTabGroupInternal(windowId);
        resolve(gid);
      } catch (err) {
        reject(err);
      }
    });
  });
}

async function getOrCreateTabGroupInternal(windowId) {
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
          // Ensure we have an anchor tab tracked
          if (anchorTabId == null) {
            const anchor = await chrome.tabs.create({
              windowId,
              url: "about:blank",
              active: false,
            });
            await chrome.tabs.group({ tabIds: [anchor.id], groupId: tabGroupId });
            anchorTabId = anchor.id;
          }
          return tabGroupId;
        }
      } catch {
        /* group deleted, continue */
      }
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
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`CDP timeout: ${method} (${CDP_TIMEOUT}ms)`))),
      CDP_TIMEOUT,
    );
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        finish(() => reject(new Error(chrome.runtime.lastError.message)));
      } else {
        finish(() => resolve(result));
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

async function tabExists(tabId) {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function debuggerAttached(tabId) {
  const targets = await new Promise((resolve, reject) => {
    chrome.debugger.getTargets((items) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(items || []);
    });
  });
  return targets.some((target) => target.tabId === tabId && target.attached);
}

function isRecoverableCdpError(err) {
  const msg = err?.message || String(err);
  return /CDP timeout|not attached|No tab with id|Debuggee|detached|closed/i.test(msg);
}

const RETRYABLE_CDP_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "DOM.describeNode",
  "DOM.getBoxModel",
  "DOM.getContentQuads",
  "DOM.getDocument",
  "DOM.querySelector",
  "Page.captureScreenshot",
  "Target.getTargets",
]);

function isSafeCdpRetry(method) {
  return RETRYABLE_CDP_METHODS.has(method);
}

async function detachDebugger(tabId, opts = {}) {
  if (opts.forget) attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* ok */
  }
}

async function enableDebugDomains(tabId) {
  await cdpSendCommand(tabId, "Page.enable");
  await cdpSendCommand(tabId, "Network.enable");
  await cdpSendCommand(tabId, "Runtime.enable");
  await cdpSendCommand(tabId, "DOM.enable");
  try {
    await cdpSendCommand(tabId, "Accessibility.enable");
  } catch {
    /* optional */
  }
}

async function recoverDebugger(tabId, reason) {
  console.warn("shunt: recovering debugger", { tabId, reason });
  await detachDebugger(tabId);
  if (!(await tabExists(tabId))) {
    attachedTabs.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    await enableDebugDomains(tabId);
    attachedTabs.add(tabId);
  } catch (err) {
    await detachDebugger(tabId, { forget: true });
    throw err;
  }
}

async function ensureDebuggerReady(tabId) {
  if (!attachedTabs.has(tabId)) {
    throw new Error(`Tab ${tabId} not attached. Call attach first.`);
  }
  if (!(await tabExists(tabId))) {
    attachedTabs.delete(tabId);
    throw new Error(`Tab ${tabId} no longer exists`);
  }
  if (!(await debuggerAttached(tabId))) {
    await recoverDebugger(tabId, "debugger target not attached");
  }
}

async function sendCdpWithRecovery(tabId, method, params, opts = {}) {
  await ensureDebuggerReady(tabId);

  if (method === "Target.getTargets") {
    return await cdpGetTargets();
  }

  try {
    return await cdpSendCommand(tabId, method, params);
  } catch (err) {
    if (!opts.retryAfterSend || !isRecoverableCdpError(err) || !isSafeCdpRetry(method)) throw err;
    await recoverDebugger(tabId, err.message || String(err));
    return await cdpSendCommand(tabId, method, params);
  }
}

async function getLiveAttachedTabs() {
  const live = [];
  const stale = [];
  for (const tabId of Array.from(attachedTabs)) {
    if (!(await tabExists(tabId))) {
      attachedTabs.delete(tabId);
      continue;
    }
    if (await debuggerAttached(tabId)) live.push(tabId);
    else stale.push(tabId);
  }
  return { live, stale };
}

// ═══════════════════════════════════════════════════════════════
// Request handlers
// ═══════════════════════════════════════════════════════════════

async function h_createWindow(params) {
  const { url, incognito, focused } = params || {};
  const win = await chrome.windows.create({
    url: url || "about:blank",
    incognito: incognito || false,
    focused: focused !== false,
  });
  return { windowId: win.id, focused: win.focused };
}

async function h_closeWindow(params) {
  const { windowId } = params;
  // If the Shunt group is in this window, move it to another window first
  if (tabGroupId != null && groupWindowId === windowId) {
    const wins = await chrome.windows.getAll({ populate: false });
    const other = wins.find((w) => w.id !== windowId);
    if (other) {
      await chrome.tabGroups.move(tabGroupId, { windowId: other.id, index: -1 });
      groupWindowId = other.id;
    } else {
      // Last window — just let the group die with the window
      tabGroupId = null;
      groupWindowId = null;
      anchorTabId = null;
    }
  }
  try {
    await chrome.windows.remove(windowId);
  } catch {
    /* ok */
  }
  return { windowId };
}

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
      await detachDebugger(tabId, { forget: true });
    }
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* ok */
    }
    return { tabId };
  });
}

async function h_attach(params) {
  const { tabId } = params;
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) {
      if ((await tabExists(tabId)) && (await debuggerAttached(tabId))) {
        return { tabId, alreadyAttached: true, verified: true };
      }
      attachedTabs.delete(tabId);
    }

    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      await enableDebugDomains(tabId);
      attachedTabs.add(tabId);
      return { tabId, attached: true };
    } catch (err) {
      await detachDebugger(tabId, { forget: true });
      throw err;
    }
  });
}

async function h_detach(params) {
  const { tabId } = params;
  return withTabLock(tabId, async () => {
    if (attachedTabs.has(tabId)) {
      await detachDebugger(tabId, { forget: true });
    }
    return { tabId };
  });
}

async function h_executeCdp(params) {
  const { tabId, method, params: cdpParams } = params;
  return withTabLock(tabId, async () => {
    const result = await sendCdpWithRecovery(tabId, method, cdpParams, {
      retryAfterSend: isSafeCdpRetry(method),
    });
    return { tabId, method, result };
  });
}

async function h_screenshot(params) {
  const { tabId, format, quality, clip, fromSurface } = params || {};
  return withTabLock(tabId, async () => {
    const p = { format: format || "png" };
    if (quality != null) p.quality = quality;
    if (clip) p.clip = clip;
    if (fromSurface != null) p.fromSurface = fromSurface;
    const result = await sendCdpWithRecovery(tabId, "Page.captureScreenshot", p, {
      retryAfterSend: true,
    });
    return { tabId, data: result.data, format: p.format };
  });
}

async function h_click(params) {
  const { tabId, x, y, button, clickCount } = params;
  return withTabLock(tabId, async () => {
    await ensureDebuggerReady(tabId);
    // Mouse move before click to position cursor
    await cdpSendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
      buttons: 0,
      modifiers: 0,
    });
    const btn = button || "left";
    const btnMask = btn === "left" ? 1 : btn === "right" ? 2 : 4;
    const args = {
      type: "mousePressed",
      x,
      y,
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
    await ensureDebuggerReady(tabId);
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
    await ensureDebuggerReady(tabId);
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
  const tabList = [];
  for (const t of tabs) {
    let groupTitle = null;
    if (t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      try {
        const g = await chrome.tabGroups.get(t.groupId);
        groupTitle = g ? g.title : null;
      } catch {
        /* ok */
      }
    }
    tabList.push({
      id: t.id,
      title: t.title,
      url: t.url,
      active: t.active,
      windowId: t.windowId,
      groupId: t.groupId,
      groupTitle: groupTitle,
    });
  }
  return { tabs: tabList };
}

async function h_activateTab(params) {
  const { tabId } = params;
  const tab = await chrome.tabs.get(tabId);
  // Expand the containing tab group + focus its window so
  // document.visibilityState transitions to "visible" (rAF unthrottled).
  // Required for any task that exercises animation/game loops.
  if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    await chrome.tabGroups.update(tab.groupId, { collapsed: false });
  }
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { tabId };
}

async function h_getSession() {
  const { live, stale } = await getLiveAttachedTabs();
  return {
    groupWindowId,
    tabGroupId,
    anchorTabId,
    attachedTabs: live,
    staleAttachedTabs: stale,
  };
}

async function h_getStatus() {
  const { live, stale } = await getLiveAttachedTabs();
  return {
    connected: true,
    nativeHost: port ? "connected" : "disconnected",
    nativeStatus,
    attachedTabs: live,
    attachedCount: live.length,
    staleAttachedTabs: stale,
    staleAttachedCount: stale.length,
    groupWindowId,
    tabGroupId,
    anchorTabId,
  };
}

async function h_finalizeTabs(params) {
  const { keep } = params;
  const keepSet = new Set(keep || []);

  // 1. If tabGroupId is currently null (e.g. SW restarted), attempt to recover the active Shunt group first
  if (tabGroupId == null) {
    try {
      const wins = await chrome.windows.getAll({ populate: true });
      for (const win of wins) {
        for (const tab of win.tabs ?? []) {
          if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group && group.title === "Shunt") {
            tabGroupId = group.id;
            groupWindowId = group.windowId;
            if (tab.url === "about:blank") anchorTabId = tab.id;
            break;
          }
        }
        if (tabGroupId != null) break;
      }
    } catch {
      /* ok */
    }
  }

  // Always protect the anchor tab — closing it would delete the entire group
  if (anchorTabId != null) {
    keepSet.add(anchorTabId);
  }

  // Detach tabs not in keep list
  for (const tabId of Array.from(attachedTabs)) {
    if (!keepSet.has(tabId)) {
      await h_detach({ tabId });
    }
  }

  // Close agent tabs not in keep list (query by group)
  if (tabGroupId != null) {
    const tabs = await chrome.tabs.query({ groupId: tabGroupId });
    for (const tab of tabs) {
      if (!keepSet.has(tab.id)) {
        try {
          await chrome.tabs.remove(tab.id);
        } catch {
          /* ok */
        }
      }
    }
  }

  // Find and clean up any other duplicate/orphaned Shunt groups and their tabs
  try {
    const wins = await chrome.windows.getAll({ populate: true });
    for (const win of wins) {
      for (const tab of win.tabs ?? []) {
        if (tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) continue;
        try {
          const group = await chrome.tabGroups.get(tab.groupId);
          if (group && group.title === "Shunt" && group.id !== tabGroupId) {
            if (!keepSet.has(tab.id)) {
              await chrome.tabs.remove(tab.id);
            }
          }
        } catch {
          /* ok */
        }
      }
    }
  } catch {
    /* ok */
  }

  return { kept: Array.from(keepSet) };
}
async function h_findElement(params) {
  const { tabId, text, selector } = params;
  return withTabLock(tabId, async () => {
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

    const result = await sendCdpWithRecovery(tabId, "Runtime.evaluate", {
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
    const result = await sendCdpWithRecovery(tabId, "Runtime.evaluate", {
      expression: "document.body?.innerText || ''",
      returnByValue: true,
    });
    let text = result.result?.value || "";
    const limit = maxLength || 10000;
    if (text.length > limit) text = `${text.substring(0, limit)}...`;
    return { tabId, text, truncated: text.length >= limit };
  });
}

// ═══════════════════════════════════════════════════════════════
// Handler router
// ═══════════════════════════════════════════════════════════════

const handlers = {
  createWindow: h_createWindow,
  closeWindow: h_closeWindow,
  createTab: h_createTab,
  closeTab: h_closeTab,
  attach: h_attach,
  detach: h_detach,
  executeCdp: h_executeCdp,
  screenshot: h_screenshot,
  click: h_click,
  type: h_type,
  scroll: h_scroll,
  getUserTabs: h_getUserTabs,
  activateTab: h_activateTab,
  getSession: h_getSession,
  getStatus: h_getStatus,
  finalizeTabs: h_finalizeTabs,
  findElement: h_findElement,
  getPageText: h_getPageText,
  ping: h_ping,
};

// Notification handlers (one-way, no id)
function handleNotification(msg) {
  const { method } = msg;
  switch (method) {
    case "heartbeat":
      lastHeartbeat = Date.now();
      break;
    // Add more notification handlers here
  }
}

function recordNativeActivity() {
  lastHeartbeat = Date.now();
  if (!heartbeatArmed) startHeartbeat();
}

async function handleRequest(msg, responsePort) {
  recordNativeActivity();
  const { id, method, params } = msg;
  if (id == null) {
    handleNotification(msg);
    return;
  }
  const handler = handlers[method];
  if (!handler) {
    sendError(id, -1, `Method not found: ${method}`, responsePort);
    return;
  }
  try {
    const result = await handler(params);
    sendResponse(id, result, responsePort);
  } catch (err) {
    sendError(id, -2, err.message || String(err), responsePort);
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
const HEARTBEAT_CHECK_PERIOD = 30; // seconds — MV3 alarms must be at least 30s
const HEARTBEAT_GRACE = 60; // seconds — grace period before cleanup on first connect
const HEARTBEAT_TIMEOUT = 90; // seconds — cleanup if no activity this long

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
  for (const tabId of Array.from(attachedTabs)) {
    await detachDebugger(tabId, { forget: true });
  }
}

// Connectivity check (simple round-trip, no side effects)
function h_ping() {
  return { ok: true };
}

// Heartbeat received from CLI via notification

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === NATIVE_RECONNECT_NAME) {
    connect("watchdog");
    return;
  }

  if (alarm.name !== HEARTBEAT_NAME || !heartbeatArmed) return;

  const elapsed = (Date.now() - lastHeartbeat) / 1000;

  // Grace period on first connect: CLI may still be starting up
  if (elapsed < HEARTBEAT_GRACE) return;

  if (elapsed > HEARTBEAT_TIMEOUT) {
    stopHeartbeat();
    await cleanup("heartbeat timeout");
    sendNotification("statusReport", {
      report: {
        nativeHost: port ? "connected" : "unreachable",
        connected: !!port,
        attachedTabs: [],
        attachedCount: 0,
      },
    });
  }
});

// ═══════════════════════════════════════════════════════════════
// Native Messaging connection
// ═══════════════════════════════════════════════════════════════

const NATIVE_RECONNECT_NAME = "shunt-native-reconnect";
const NATIVE_RECONNECT_PERIOD = 30; // seconds — MV3 alarms must be at least 30s
const NATIVE_STATUS_KEY = "shuntNativeStatus";
const NATIVE_CONFIRM_DELAY_MS = 500;
const NATIVE_RETRY_INITIAL_MS = 1_000;
const NATIVE_RETRY_MAX_MS = 30_000;

const nativeStatus = {
  state: "disconnected",
  connected: false,
  updatedAt: null,
  lastAttemptAt: null,
  lastAttemptReason: null,
  lastConnectedAt: null,
  lastDisconnectedAt: null,
  lastError: null,
};

let nativeStatusReady = null;
let nativeConfirmTimer = null;
let nativeRetryTimer = null;
let nativeRetryDelayMs = NATIVE_RETRY_INITIAL_MS;

function restoreNativeStatus() {
  if (nativeStatusReady) return nativeStatusReady;
  nativeStatusReady = new Promise((resolve) => {
    try {
      chrome.storage.local.get(NATIVE_STATUS_KEY, (items) => {
        if (items?.[NATIVE_STATUS_KEY]) {
          Object.assign(nativeStatus, items[NATIVE_STATUS_KEY], {
            state: port ? nativeStatus.state : "disconnected",
            connected: !!port,
          });
        }
        resolve();
      });
    } catch {
      resolve();
    }
  });
  return nativeStatusReady;
}

function persistNativeStatus(patch) {
  Object.assign(nativeStatus, patch, { updatedAt: Date.now(), connected: !!port });
  try {
    chrome.storage.local.set({ [NATIVE_STATUS_KEY]: { ...nativeStatus } });
  } catch {
    /* storage may be unavailable during shutdown */
  }
}

function ensureNativeWatchdog() {
  chrome.alarms.create(NATIVE_RECONNECT_NAME, { periodInMinutes: NATIVE_RECONNECT_PERIOD / 60 });
}

function clearNativeConfirmTimer() {
  if (nativeConfirmTimer != null) {
    clearTimeout(nativeConfirmTimer);
    nativeConfirmTimer = null;
  }
}

function clearNativeRetryTimer() {
  if (nativeRetryTimer != null) {
    clearTimeout(nativeRetryTimer);
    nativeRetryTimer = null;
  }
}

function scheduleNativeRetry(reason = "retry") {
  ensureNativeWatchdog();
  if (port || nativeRetryTimer != null) return;
  const delayMs = nativeRetryDelayMs;
  nativeRetryDelayMs = Math.min(nativeRetryDelayMs * 2, NATIVE_RETRY_MAX_MS);
  nativeRetryTimer = setTimeout(() => {
    nativeRetryTimer = null;
    connect(reason);
  }, delayMs);
}

function confirmNativeConnected(nextPort, reason) {
  if (port !== nextPort) return;
  nativeRetryDelayMs = NATIVE_RETRY_INITIAL_MS;
  persistNativeStatus({
    state: "connected",
    lastConnectedAt: Date.now(),
    lastAttemptReason: reason,
    lastError: null,
  });
  startHeartbeat();
  console.log("shunt: connected");
}

function connect(reason = "manual") {
  ensureNativeWatchdog();
  if (port) return;
  if (nativeRetryTimer != null && reason === "watchdog") return;

  clearNativeRetryTimer();
  persistNativeStatus({
    state: "connecting",
    lastAttemptAt: Date.now(),
    lastAttemptReason: reason,
  });

  try {
    const nextPort = chrome.runtime.connectNative("com.opensetsuna.shunt");
    port = nextPort;

    nextPort.onMessage.addListener((msg) => {
      handleRequest(msg, nextPort).catch((err) => {
        console.error("shunt: handler error", err);
      });
    });

    nextPort.onDisconnect.addListener(async () => {
      if (port !== nextPort) return;
      const disconnectReason = chrome.runtime.lastError?.message ?? null;
      console.warn(
        "shunt: host disconnected, triggering cleanup",
        disconnectReason ? `(${disconnectReason})` : "",
      );
      clearNativeConfirmTimer();
      stopHeartbeat();
      await cleanup(
        disconnectReason
          ? `native host disconnected: ${disconnectReason}`
          : "native host disconnected",
      );
      port = null;
      persistNativeStatus({
        state: "disconnected",
        lastDisconnectedAt: Date.now(),
        lastError: disconnectReason,
      });
      scheduleNativeRetry("disconnect");
    });

    clearNativeConfirmTimer();
    nativeConfirmTimer = setTimeout(
      () => confirmNativeConnected(nextPort, reason),
      NATIVE_CONFIRM_DELAY_MS,
    );
  } catch (err) {
    port = null;
    const message = err?.message || String(err);
    persistNativeStatus({
      state: "disconnected",
      lastDisconnectedAt: Date.now(),
      lastError: message,
    });
    console.error("shunt: connect failed", err);
    scheduleNativeRetry("connect-failed");
  }
}

// ═══════════════════════════════════════════════════════════════
// Popup (chrome.runtime.onMessage)
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { id, method } = msg;
  if (id == null) {
    sendResponse(null);
    return false;
  }
  const handler = handlers[method];
  if (!handler) {
    sendResponse({
      jsonrpc: "2.0",
      id,
      error: { code: -1, message: `Method not found: ${method}` },
    });
    return false;
  }
  handler(msg.params)
    .then((result) => {
      sendResponse({ jsonrpc: "2.0", id, result });
    })
    .catch((err) => {
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -2, message: err.message || String(err) },
      });
    });
  return true; // async
});

// ═══════════════════════════════════════════════════════════════
// Startup
// ═══════════════════════════════════════════════════════════════
async function bootNative(reason) {
  await restoreNativeStatus();
  ensureNativeWatchdog();
  connect(reason);
}

chrome.runtime.onStartup?.addListener(() => {
  bootNative("startup").catch((err) => console.error("shunt: startup boot failed", err));
});
chrome.runtime.onInstalled?.addListener(() => {
  bootNative("installed").catch((err) => console.error("shunt: installed boot failed", err));
});
chrome.runtime.onSuspend?.addListener(() => {
  persistNativeStatus({ lastAttemptReason: "suspend" });
});

bootNative("service-worker-load").catch((err) => console.error("shunt: boot failed", err));
