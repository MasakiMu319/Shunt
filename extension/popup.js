// popup.js — Shunt connection status
const $ = (id) => document.getElementById(id);

async function refresh() {
  try {
    const resp = await chrome.runtime.sendMessage({
      jsonrpc: "2.0", method: "getStatus", id: 1, params: null,
    });
    if (resp?.error) throw new Error(resp.error.message);
    const st = resp.result;
    // Native host
    const hostEl = $("host");
    hostEl.textContent = st.nativeHost;
    hostEl.className = "badge " + (st.nativeHost === "connected" ? "badge-ok" : "badge-err");
    // Window / Group
    $("win").textContent = st.groupWindowId ?? "—";
    $("grp").textContent = st.tabGroupId ?? "—";
    // Attached tabs
    if (st.attachedTabs?.length) {
      const tabsResp = await chrome.runtime.sendMessage({
        jsonrpc: "2.0", method: "getUserTabs", id: 2, params: null,
      });
      const allTabs = tabsResp?.result?.tabs || [];
      const attached = st.attachedTabs;
      $("tabs").innerHTML = allTabs
        .filter((t) => attached.includes(t.id))
        .map((t) => {
          const url = (t.url || "").slice(0, 50);
          return `<div class="row"><span class="tab-url">${eschtml(url)}</span><span class="attached">●</span></div>`;
        })
        .join("") || '<span style="color:#6c7086">none</span>';
    } else {
      $("tabs").innerHTML = '<span style="color:#6c7086">none</span>';
    }
  } catch (e) {
    const hostEl = $("host");
    hostEl.textContent = "disconnected";
    hostEl.className = "badge badge-err";
    $("tabs").innerHTML = `<span style="color:#f38ba8">${eschtml(e.message)}</span>`;
  }
}

function eschtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

$("refresh").addEventListener("click", refresh);
refresh();
