// popup.js — Shunt connection status
const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    const resp = await chrome.runtime.sendMessage({
      jsonrpc: "2.0",
      method: "getStatus",
      id: 1,
      params: null,
    });
    if (resp?.error) throw new Error(resp.error.message);
    const st = resp.result;
    // Native host
    const hostEl = $("host");
    hostEl.textContent = st.nativeHost;
    hostEl.className = `badge ${st.nativeHost === "connected" ? "badge-ok" : "badge-err"}`;
    const native = st.nativeStatus || {};
    $("watchdog").textContent = native.lastAttemptReason || "—";
    $("last-connected").textContent = fmtTime(native.lastConnectedAt);
    $("last-error").textContent = native.lastError || "—";
    // Window / Group
    $("win").textContent = st.groupWindowId ?? "—";
    $("grp").textContent = st.tabGroupId ?? "—";
    // Attached tabs
    if (st.attachedTabs?.length) {
      const tabsResp = await chrome.runtime.sendMessage({
        jsonrpc: "2.0",
        method: "getUserTabs",
        id: 2,
        params: null,
      });
      const allTabs = tabsResp?.result?.tabs || [];
      const attached = st.attachedTabs;
      $("tabs").innerHTML =
        allTabs
          .filter((t) => attached.includes(t.id))
          .map((t) => {
            const url = (t.url || "").slice(0, 50);
            return `<div class="row"><span class="tab-url">${eschtml(url)}</span><span class="attached">●</span></div>`;
          })
          .join("") || '<span class="empty">none</span>';
    } else {
      $("tabs").innerHTML = '<span class="empty">none</span>';
    }
  } catch (e) {
    const hostEl = $("host");
    hostEl.textContent = "disconnected";
    hostEl.className = "badge badge-err";
    $("watchdog").textContent = "popup-error";
    $("last-connected").textContent = "—";
    $("last-error").textContent = e.message || String(e);
    $("tabs").innerHTML = `<span class="error">${eschtml(e.message || String(e))}</span>`;
  }
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString();
}

function eschtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("refresh").addEventListener("click", refresh);
refresh();
