// Shunt Extension Background (MV3 Service Worker)
// Three commands: createTab, closeTab, cdp
// CDP events forwarded to Native Host via Native Messaging

// ── State ──
const debuggerAttached = new Set();      // Set<tabId>
const pendingCommands = new Map();       // tabId → Promise chain (per-tab mutex)

let port = null;
let backgroundWindowId = null;

// ── Per-tab mutex (from Codex) ──
// Sequentializes chrome.debugger operations per tab to avoid
// "Another debugger is already attached" errors.
function withMutex(tabId, fn) {
  const prev = pendingCommands.get(tabId) || Promise.resolve();
  const next = prev.then(fn, (err) => {
    // fn might also need to run as cleanup
    return fn(err);
  });
  pendingCommands.set(tabId, next);
  return next;
}

// ── Native Messaging ──
function connect() {
  try {
    port = chrome.runtime.connectNative("com.opensetsuna.shunt");

    port.onMessage.addListener((msg) => {
      handleCommand(msg).catch((err) => {
        console.error("shunt: command error", err);
      });
    });

    port.onDisconnect.addListener(() => {
      console.warn("shunt: native host disconnected, cleaning up");
      // Detach all debuggers
      for (const tabId of debuggerAttached) {
        chrome.debugger.detach({ tabId }).catch(() => {});
      }
      debuggerAttached.clear();
      pendingCommands.clear();
      port = null;

      // Reconnect after delay
      setTimeout(connect, 1000);
    });

    console.log("shunt: connected to native host");
  } catch (err) {
    console.error("shunt: connect failed", err);
    setTimeout(connect, 5000);
  }
}

// ── Command router ──
async function handleCommand(msg) {
  switch (msg.type) {
    case "createTab":
      return createTab(msg.url);
    case "closeTab":
      return closeTab(msg.tabId);
    case "cdp":
      return executeCdp(msg.tabId, msg.method, msg.params);
    default:
      console.warn("shunt: unknown command", msg.type);
  }
}

// ── Window management ──
async function getOrCreateBackgroundWindow() {
  if (backgroundWindowId != null) {
    try {
      await chrome.windows.get(backgroundWindowId);
      return backgroundWindowId;
    } catch {
      backgroundWindowId = null;
    }
  }

  const win = await chrome.windows.create({
    focused: false,
    type: "normal",
    url: "about:blank",
  });
  backgroundWindowId = win.id;
  return backgroundWindowId;
}

// ── createTab ──
async function createTab(url) {
  const windowId = await getOrCreateBackgroundWindow();

  const tab = await chrome.tabs.create({
    windowId,
    url,
    active: false,
  });

  // Group into "agent-browser" tab group
  try {
    await chrome.tabs.group({
      tabIds: [tab.id],
      createProperties: { windowId },
    });
  } catch {
    // Group might already exist, ignore
  }

  // Attach debugger
  await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  debuggerAttached.add(tab.id);

  // Send response immediately (CLI can waitFor Page.loadEventFired if needed)
  if (port) {
    port.postMessage({
      type: "createTab",
      tabId: tab.id,
      url: tab.url || url,
      title: tab.title || "",
    });
  }
}

// ── closeTab ──
async function closeTab(tabId) {
  return withMutex(tabId, async () => {
    if (debuggerAttached.has(tabId)) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Not attached, ignore
      }
      debuggerAttached.delete(tabId);
    }
    pendingCommands.delete(tabId);

    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // Tab already closed, ignore
    }

    if (port) {
      port.postMessage({
        type: "closeTab",
        tabId,
      });
    }
  });
}

// ── executeCdp ──
async function executeCdp(tabId, method, params) {
  return withMutex(tabId, async () => {
    if (!port) {
      console.error("shunt: no port for CDP response");
      return;
    }

    if (!debuggerAttached.has(tabId)) {
      port.postMessage({
        type: "cdpResult",
        tabId,
        method,
        error: `Debugger not attached to tab ${tabId}`,
      });
      return;
    }

    try {
      let result;
      if (method === "Target.getTargets") {
        // chrome.debugger.getTargets does not take a tabId
        result = await chromeDebuggerGetTargets();
      } else {
        result = await chromeDebuggerSendCommand(tabId, method, params);
      }

      port.postMessage({
        type: "cdpResult",
        tabId,
        method,
        result,
      });
    } catch (err) {
      port.postMessage({
        type: "cdpResult",
        tabId,
        method,
        error: err.message || String(err),
      });
    }
  });
}

function chromeDebuggerSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function chromeDebuggerGetTargets() {
  return new Promise((resolve, reject) => {
    chrome.debugger.getTargets((targets) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(targets);
      }
    });
  });
}

// ── CDP Event forwarding ──
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId && debuggerAttached.has(source.tabId)) {
    try {
      if (port) {
        port.postMessage({
          type: "cdpEvent",
          tabId: source.tabId,
          method,
          params,
        });
      }
    } catch {
      // Port disconnected, event dropped (acceptable)
    }
  }
});

// ── Debugger detach (user opened DevTools, tab crashed, etc.) ──
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId) {
    debuggerAttached.delete(source.tabId);
    pendingCommands.delete(source.tabId);

    try {
      if (port) {
        port.postMessage({
          type: "debuggerDetached",
          tabId: source.tabId,
          reason,
        });
      }
    } catch {
      // ignore
    }
  }
});

// ── Startup ──
connect();
