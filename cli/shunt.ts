#!/usr/bin/env bun
/**
 * Shunt CLI v2 — TypeScript/Bun
 * Browser automation client via JSON-RPC 2.0 over Unix socket → Extension
 */

import { type Socket, createConnection } from "node:net";

// ── Config ────────────────────────────────────────────────────────────────

const SOCKET_PATH = "/tmp/shunt.sock";

const FETCH_TIMEOUT_MS = 15_000;
const DEFUDDLE_MIN_CHARS = 200;
const CDP_POLL_INTERVAL = 500;
const CDP_POLL_MAX = 30;
const MIN_CDP_HTML = 500;
const HEARTBEAT_INTERVAL = 30_000;

// Domains where HTTP fetch returns empty/SPA shells → skip to CDP
const CDP_FIRST_DOMAINS = new Set([
  "x.com", "twitter.com",
  "youtube.com", "youtu.be",
  "instagram.com",
  "facebook.com", "fb.com",
  "reddit.com",
  "linkedin.com",
  "tiktok.com",
  "discord.com",
  "notion.so",
  "medium.com",
  "web.telegram.org", "web.telegram.org",
  "cnbc.com",       // anti-scraping: returns "DO NOT DELETE"
  "bloomberg.com",
  "wsj.com",
  "ft.com",
]);

// Anti-scraping signals in HTTP response (detect block pages)
const BLOCK_SIGNALS_TITLE = /just a moment|access denied|do not delete|blocked|captcha|are you a robot|403 forbidden|attention required/i;
const BLOCK_SIGNALS_BODY = /cf-browser-verification|challenge-platform|g-recaptcha|access denied/i;
const BLOCK_RATIO_THRESHOLD = 0.03; // text chars / html bytes below this → likely JS shell

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CDP_WAIT_EXPR = [
  "document.readyState === 'complete' &&",
  "((document.querySelector(\"article, main, [role='main']\")?.innerText ||",
  "document.body?.innerText || '').trim().length > 200)",
].join(" ");

const CDP_EXTRACT_EXPR = "document.documentElement.outerHTML";

// Plain text mode: bypass defuddle, get body.innerText directly
const CDP_TEXT_EXPR = "document.body.innerText";

// ── JSON-RPC Client ───────────────────────────────────────────────────────

class ShuntRPC {
  private sock: Socket | null = null;
  private nextId = 1;

  connect(): Socket {
    if (this.sock) return this.sock;
    try {
      this.sock = createConnection(SOCKET_PATH);
      this.sock.setTimeout(5_000);
    } catch {
      throw new Error(
        "Shunt not running. Is Helium open with Shunt extension loaded?\n" +
          "  open -a Helium → chrome://extensions → Load Unpacked → .../Shunt/extension",
      );
    }
    this.sock.on("error", () => {});
    return this.sock;
  }

  close(): void {
    if (this.sock) {
      try { this.sock.destroy(); } catch { /* ok */ }
      this.sock = null;
    }
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    const s = this.connect();
    const id = this.nextId++;

    const msg: Record<string, unknown> = { jsonrpc: "2.0", method, id };
    if (params !== undefined) msg.params = params;

    const payload = JSON.stringify(msg) + "\n";

    return new Promise((resolve, reject) => {
      let buf = "";

      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line);
            if (resp.id === id) {
              cleanup();
              if (resp.error) {
                const err = resp.error as { code?: number; message?: string };
                reject(new Error(`[${err.code ?? "?"}] ${err.message ?? "unknown"}`));
              } else {
                resolve(resp.result);
              }
              return;
            }
          } catch { /* skip malformed */ }
        }
      };

      const onError = (err: Error) => {
        cleanup();
        reject(new Error(`Connection error: ${err.message}`));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("Socket closed before response"));
      };

      function cleanup() {
        s.off("data", onData);
        s.off("error", onError);
        s.off("close", onClose);
      }

      s.on("data", onData);
      s.once("error", onError);
      s.once("close", onClose);

      if (!s.write(payload)) {
        s.once("drain", () => {});
      }
    });
  }
}
// ── Heartbeat (daemon) ────────────────────────────────────────────────────

function sendHeartbeat(): void {
  try {
    const s = createConnection(SOCKET_PATH);
    s.setTimeout(3_000);
    s.write(JSON.stringify({ jsonrpc: "2.0", method: "heartbeat" }) + "\n", () => {
      s.destroy();
    });
  } catch { /* silent */ }
}

setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);

// ── Defuddle wrapper ──────────────────────────────────────────────────────

async function defuddleHtml(html: string, url: string): Promise<{ title: string; text: string }> {
  try {
    const { Defuddle } = await import("defuddle/node");
    const result = await Defuddle(html, url, { markdown: true });
    return { title: result.title || "", text: result.content || "" };
  } catch {
    const stripped = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, "\"")
      .replace(/&#x27;/g, "'")
      .replace(/\s{2,}/g, "\n")
      .trim();
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return { title: titleMatch?.[1]?.trim() || "", text: stripped };
  }
}

// ── read-page command ─────────────────────────────────────────────────────

function isCdpFirst(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.replace(/^www\./, "");
    for (const d of CDP_FIRST_DOMAINS) {
      if (host === d || host.endsWith("." + d)) return true;
    }
  } catch { /* malformed URL */ }
  return false;
}

function isBlockPage(html: string, text: string): boolean {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]?.trim() || "";
  if (BLOCK_SIGNALS_TITLE.test(title)) return true;
  if (BLOCK_SIGNALS_BODY.test(html)) return true;
  // text-to-html ratio: if extracted text is tiny relative to html size
  if (html.length > 5000 && text.length / html.length < BLOCK_RATIO_THRESHOLD) return true;
  return false;
}

type ReadMode = "raw" | "defuddle" | "text";

async function readPage(url: string, opts?: {
  mode?: ReadMode;
}): Promise<{
  source: string; title: string; charCount: number; elapsed: number; content: string;
}> {
  const start = Date.now();
  let html = "";

  // ── Phase 1: HTTP (skip for known JS-heavy domains) ─────────────────
  if (!isCdpFirst(url)) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("html") && !ct.includes("xml")) {
        throw new Error(`unexpected content-type: ${ct}`);
      }
      html = await res.text();

      // Mode: raw — return HTML as-is
      if (opts?.mode === "raw") {
        return {
          source: "http", title: "", charCount: html.length,
          elapsed: Date.now() - start,
          content: html,
        };
      }

      // Mode: text — strip HTML tags, return plain text
      if (opts?.mode === "text") {
        const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        return {
          source: "http", title: "", charCount: text.length,
          elapsed: Date.now() - start,
          content: text,
        };
      }

      // Mode: defuddle (default)
      const { title, text } = await defuddleHtml(html, url);

      // Block-page detection
      if (!isBlockPage(html, text) && text.length >= DEFUDDLE_MIN_CHARS) {
        return {
          source: "http", title,
          charCount: text.length,
          elapsed: Date.now() - start,
          content: text,
        };
      }
    } catch { /* fall through to CDP */ }
  }

  // ── Phase 2: CDP fallback ───────────────────────────────────────────
  const rpc = new ShuntRPC();
  let tabId = 0;
  try {
    const create = (await rpc.call("createTab")) as { tabId: number };
    tabId = create.tabId;
    await rpc.call("attach", { tabId });
    await rpc.call("executeCdp", { tabId, method: "Page.navigate", params: { url } });

    const waitExpr = `(() => (${CDP_WAIT_EXPR}))()`;
    let contentReady = false;
    for (let i = 0; i < CDP_POLL_MAX; i++) {
      await Bun.sleep(CDP_POLL_INTERVAL);
      try {
        const poll = (await rpc.call("executeCdp", {
          tabId, method: "Runtime.evaluate",
          params: { expression: waitExpr, returnByValue: true },
        })) as { result?: { result?: { value?: unknown } } };
        if (poll.result?.result?.value === true) { contentReady = true; break; }
      } catch { /* keep polling */ }
    }

    // Mode: text — get body.innerText directly, bypass defuddle
    if (opts?.mode === "text") {
      const textResult = (await rpc.call("executeCdp", {
        tabId, method: "Runtime.evaluate",
        params: { expression: CDP_TEXT_EXPR, returnByValue: true },
      })) as { result?: { result?: { value?: string } } };
      const text = textResult.result?.result?.value ?? "";
      if (!text || text.length < 50) throw new Error("CDP text mode returned insufficient content");
      return {
        source: "cdp", title: "", charCount: text.length,
        elapsed: Date.now() - start,
        content: text,
      };
    }

    const htmlResult = (await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: { expression: CDP_EXTRACT_EXPR, returnByValue: true },
    })) as { result?: { result?: { value?: string } } };

    html = htmlResult.result?.result?.value ?? "";
    if (!html || html.length < MIN_CDP_HTML) throw new Error("CDP returned insufficient HTML");

    // Mode: raw — return HTML as-is
    if (opts?.mode === "raw") {
      return {
        source: "cdp", title: "", charCount: html.length,
        elapsed: Date.now() - start,
        content: html,
      };
    }

    // Mode: defuddle (default)
    const { title, text } = await defuddleHtml(html, url);
    if (text.length < DEFUDDLE_MIN_CHARS) {
      throw new Error(
        `defuddle produced ${text.length} chars from ${html.length} bytes HTML` +
        (contentReady ? "" : "; page may not have finished rendering"),
      );
    }
    return {
      source: "cdp", title,
      charCount: text.length,
      elapsed: Date.now() - start,
      content: text,
    };
  } finally {
    try { await rpc.call("detach", { tabId }); } catch { /* ok */ }
    try { await rpc.call("closeTab", { tabId }); } catch { /* ok */ }
    rpc.close();
  }
}

// ── Command handlers ──────────────────────────────────────────────────────

async function cmd_createTab(rpc: ShuntRPC) {
  console.log(JSON.stringify(await rpc.call("createTab")));
}

async function cmd_closeTab(rpc: ShuntRPC, tabId: number) {
  console.log(JSON.stringify(await rpc.call("closeTab", { tabId })));
}

async function cmd_attach(rpc: ShuntRPC, tabId: number) {
  console.log(JSON.stringify(await rpc.call("attach", { tabId })));
}

async function cmd_detach(rpc: ShuntRPC, tabId: number) {
  console.log(JSON.stringify(await rpc.call("detach", { tabId })));
}

async function cmd_cdp(rpc: ShuntRPC, tabId: number, method: string, paramsStr?: string) {
  let cdpParams: unknown = undefined;
  if (paramsStr) {
    try { cdpParams = JSON.parse(paramsStr); } catch { cdpParams = paramsStr; }
  }
  console.log(JSON.stringify(
    await rpc.call("executeCdp", { tabId, method, params: cdpParams }),
  ));
}

async function cmd_screenshot(rpc: ShuntRPC, args: Record<string, unknown>) {
  const params: Record<string, unknown> = { tabId: Number(args.tab_id) };
  if (args.format) params.format = args.format;
  if (args.quality !== undefined) params.quality = Number(args.quality);
  if (args.clip) params.clip = JSON.parse(args.clip as string);
  const result = (await rpc.call("screenshot", params)) as { data?: string };
  console.log(result.data ?? "");
}

async function cmd_click(rpc: ShuntRPC, tabId: number, x: number, y: number, double: boolean) {
  const events = double
    ? "'mousedown','mouseup','click','pointerdown','pointerup','dblclick','mousedown','mouseup','click','pointerdown','pointerup'"
    : "'mousedown','mouseup','click','pointerdown','pointerup'";
  const label = double ? "double-clicked:" : "clicked:";
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const e=document.elementFromPoint(${x},${y});if(!e)return'no-element';[${events}].forEach(t=>{e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:${x},clientY:${y},button:0,detail:t==='dblclick'?2:1}))});return'${label}'+e.tagName})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_type(rpc: ShuntRPC, tabId: number, text: string) {
  const escaped = JSON.stringify(text).slice(1, -1);
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const t=${JSON.stringify(text)};const e=document.activeElement;if(!e)return'no-active-element';const g=e.tagName.toLowerCase();if(g==='input'||g==='textarea'){const s=e.selectionStart??e.value.length;e.value=e.value.slice(0,s)+t+e.value.slice(e.selectionEnd??s);e.selectionStart=e.selectionEnd=s+t.length;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return'typed:'+g}if(e.isContentEditable){const sel=window.getSelection();if(sel.rangeCount){const r=sel.getRangeAt(0);r.deleteContents();r.insertNode(document.createTextNode(t));r.collapse(false);sel.removeAllRanges();sel.addRange(r)}else{e.appendChild(document.createTextNode(t))}e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return'typed:contenteditable'}return'typed:unknown-'+g})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_keypress(rpc: ShuntRPC, tabId: number, key: string) {
  const KEY_CODES: Record<string, number> = {
    Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34,
  };
  const kc = KEY_CODES[key] || 0;
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const e=document.activeElement||document.body;const o={key:'${key}',code:'${key}',keyCode:${kc},which:${kc},bubbles:true,cancelable:true,composed:true};['keydown','keypress','keyup'].forEach(t=>{e.dispatchEvent(new KeyboardEvent(t,o))});return'pressed:${key}'})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_move(rpc: ShuntRPC, tabId: number, x: number, y: number) {
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const e=document.elementFromPoint(${x},${y});if(!e)return'no-element';['mouseover','mousemove','mouseenter'].forEach(t=>{e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:${x},clientY:${y},view:window}))});return'moved:'+e.tagName})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_drag(rpc: ShuntRPC, tabId: number, pathStr: string) {
  const pts = pathStr.split(" ").map(p => {
    const [x, y] = p.split(",");
    return [Number(x), Number(y)];
  });
  const ptsJson = JSON.stringify(pts);
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const p=${ptsJson};if(p.length<2)return'drag-needs-2+pts';let e=document.elementFromPoint(p[0][0],p[0][1]);if(!e)return'no-element-at-start';const o=(x,y,b)=>({bubbles:true,cancelable:true,clientX:x,clientY:y,button:0,buttons:b,view:window});e.dispatchEvent(new MouseEvent('pointerdown',o(p[0][0],p[0][1],1)));e.dispatchEvent(new MouseEvent('mousedown',o(p[0][0],p[0][1],1)));for(let i=1;i<p.length-1;i++){e=document.elementFromPoint(p[i][0],p[i][1]);if(e){e.dispatchEvent(new MouseEvent('pointermove',o(p[i][0],p[i][1],1)));e.dispatchEvent(new MouseEvent('mousemove',o(p[i][0],p[i][1],1)))}}const l=p[p.length-1];e=document.elementFromPoint(l[0],l[1]);if(e){e.dispatchEvent(new MouseEvent('pointermove',o(l[0],l[1],1)));e.dispatchEvent(new MouseEvent('mousemove',o(l[0],l[1],1)));e.dispatchEvent(new MouseEvent('pointerup',o(l[0],l[1],0)));e.dispatchEvent(new MouseEvent('mouseup',o(l[0],l[1],0)))}return'dragged:'+p.length+'pts'})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_downloadMedia(rpc: ShuntRPC, tabId: number, x: number, y: number) {
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const e=document.elementFromPoint(${x},${y});if(!e)return JSON.stringify({error:'no-element'});const m=e.closest?.('img, video, audio, source, a[href]')??e;const u=m.currentSrc??m.src??m.href??'';if(!u)return JSON.stringify({error:'no-media-url',tag:m.tagName});fetch(u).then(r=>r.blob()).then(b=>{const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=u.split('/').pop().split('?')[0]||'download';document.body.appendChild(a);a.click();setTimeout(()=>{document.body.removeChild(a);URL.revokeObjectURL(a.href)},5000)}).catch(e=>console.error('download error:',e));return JSON.stringify({url:u,tag:m.tagName})})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_history(rpc: ShuntRPC, tabId: number, direction: string, index: number) {
  let expr: string;
  if (direction === "back") expr = "history.back();setTimeout(()=>{},100);'back-ok'";
  else if (direction === "forward") expr = "history.forward();setTimeout(()=>{},100);'forward-ok'";
  else if (direction === "goto") expr = `history.go(${index});setTimeout(()=>{},100);'goto-ok'`;
  else expr = `JSON.stringify({length:history.length,current:${tabId}})`;
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: { expression: expr, returnByValue: true },
    }),
  ));
}

async function cmd_scroll(rpc: ShuntRPC, tabId: number, dx: number, dy: number) {
  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const b=[window.scrollX,window.scrollY];window.scrollBy({left:${dx},top:${dy},behavior:'instant'});const a=[window.scrollX,window.scrollY];return JSON.stringify({from:b,to:a,delta:[a[0]-b[0],a[1]-b[1]]})})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_userTabs(rpc: ShuntRPC) {
  console.log(JSON.stringify(await rpc.call("getUserTabs"), null, 2));
}

async function cmd_activate(rpc: ShuntRPC, tabId: number) {
  console.log(JSON.stringify(await rpc.call("activateTab", { tabId })));
}

async function cmd_session(rpc: ShuntRPC) {
  console.log(JSON.stringify(await rpc.call("getSession"), null, 2));
}

async function cmd_status(rpc: ShuntRPC) {
  try {
    const status = (await rpc.call("getStatus")) as Record<string, unknown>;
    console.log("SHUNT: CONNECTED");
    console.log(`  native host: ${status.nativeHost ?? "?"}`);
    console.log(`  group window: ${status.groupWindowId ?? "?"}`);
    console.log(`  tab group:    ${status.tabGroupId ?? "?"}`);
    const attached = (status.attachedTabs as number[]) ?? [];
    console.log(`  attached (${attached.length}): ${attached.length ? attached.join(",") : "none"}`);

    try {
      const tabsRes = (await rpc.call("getUserTabs")) as { tabs?: Array<{ id: number; url: string; active?: boolean }> };
      const tabs = tabsRes.tabs ?? [];
      console.log(`  browser tabs (${tabs.length}):`);
      for (const t of tabs.slice(0, 10)) {
        const url = (t.url ?? "").slice(0, 60);
        const active = t.active ? " \u25C0 active" : "";
        const att = attached.includes(t.id) ? " [attached]" : "";
        console.log(`    ${t.id} ${url}${att}${active}`);
      }
      if (tabs.length > 10) console.log(`    ... (${tabs.length - 10} more)`);
    } catch {
      console.log("  (tabs: error fetching)");
    }
  } catch (e) {
    console.log("SHUNT: OFFLINE");
    console.log(`  error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function cmd_findElement(rpc: ShuntRPC, tabId: number, opts?: { text?: string; selector?: string }) {
  const params: Record<string, unknown> = { tabId };
  if (opts?.text) params.text = opts.text;
  if (opts?.selector) params.selector = opts.selector;
  console.log(JSON.stringify(await rpc.call("findElement", params), null, 2));
}

async function cmd_getText(rpc: ShuntRPC, tabId: number, maxLength: number) {
  const result = (await rpc.call("getPageText", { tabId, maxLength })) as { text?: string };
  console.log(result.text ?? "");
}

async function cmd_snapshot(rpc: ShuntRPC, tabId: number, depth: number) {
  const result = (await rpc.call("executeCdp", {
    tabId, method: "Accessibility.getFullAXTree",
    params: { depth },
  })) as { result?: { nodes?: Array<Record<string, unknown>> } };
  const nodes = result.result?.nodes ?? [];
  if (!nodes.length) {
    console.log("(empty)");
    return;
  }

  const nodeMap = new Map<string, Record<string, unknown>>();
  const roots: Record<string, unknown>[] = [];
  for (const n of nodes) {
    nodeMap.set(n.nodeId as string, n);
    if (!n.parentId) roots.push(n);
  }

  function walk(node: Record<string, unknown>, depth: number) {
    const indent = "  ".repeat(Math.min(depth, 8));
    if (!node.ignored) {
      const role = ((node.role as Record<string, string>) ?? {}).value ?? "?";
      const name = ((node.name as Record<string, string>) ?? {}).value ?? "";
      const ref = node.backendDOMNodeId ? ` [ref=e${node.backendDOMNodeId}]` : "";
      const nameStr = name ? ` "${name.slice(0, 80)}"` : "";
      console.log(`${indent}${role}${nameStr}${ref}`);
    }
    for (const cid of (node.childIds as string[]) ?? []) {
      const child = nodeMap.get(cid);
      if (child) walk(child, depth + 1);
    }
  }

  for (const root of roots) walk(root, 0);
}

async function cmd_clickRef(rpc: ShuntRPC, tabId: number, nodeId: number) {
  // Scroll into view
  await rpc.call("executeCdp", {
    tabId, method: "DOM.scrollIntoViewIfNeeded",
    params: { backendNodeId: nodeId },
  });

  // Get quads
  let x = 0, y = 0;
  const quadsRes = (await rpc.call("executeCdp", {
    tabId, method: "DOM.getContentQuads",
    params: { backendNodeId: nodeId },
  })) as { result?: { quads?: number[][] } };
  const quads = quadsRes.result?.quads ?? [];

  if (quads.length) {
    const q = quads[0];
    x = Math.round((q[0] + q[4]) / 2);
    y = Math.round((q[1] + q[5]) / 2);
  } else {
    const resolve = (await rpc.call("executeCdp", {
      tabId, method: "DOM.resolveNode",
      params: { backendNodeId: nodeId },
    })) as { result?: { object?: { objectId?: string } } };
    const objId = resolve.result?.object?.objectId;
    if (!objId) { console.error("Error: could not resolve node"); process.exit(1); }

    const box = (await rpc.call("executeCdp", {
      tabId, method: "DOM.getBoxModel",
      params: { objectId: objId },
    })) as { result?: { model?: { content?: number[] } } };
    const quad = box.result?.model?.content;
    if (!quad || quad.length < 8) { console.error("Error: no box model"); process.exit(1); }
    x = Math.round((quad[0] + quad[4]) / 2);
    y = Math.round((quad[1] + quad[5]) / 2);
  }

  console.log(JSON.stringify(
    await rpc.call("executeCdp", {
      tabId, method: "Runtime.evaluate",
      params: {
        expression: `(()=>{const e=document.elementFromPoint(${x},${y});if(!e)return'no-element';['mousedown','mouseup','click','pointerdown','pointerup'].forEach(t=>{e.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:${x},clientY:${y},button:0}))});return'clicked:'+e.tagName})()`,
        returnByValue: true,
      },
    }),
  ));
}

async function cmd_finalize(rpc: ShuntRPC, keep: number[]) {
  console.log(JSON.stringify(await rpc.call("finalizeTabs", { keep })));
}

async function cmd_ping(rpc: ShuntRPC) {
  try {
    const result = (await rpc.call("ping")) as { ok?: boolean };
    if (result.ok) {
      console.log("shunt ok");
    } else {
      console.error("shunt unexpected response");
      process.exit(1);
    }
  } catch (e) {
    console.error(`shunt unreachable: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

async function cmd_readPage(url: string, mode: ReadMode) {
  try {
    const result = await readPage(url, { mode });
    console.log(JSON.stringify(result));
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

const USAGE = `Shunt CLI v2 — Browser automation via Helium Extension

Usage: shunt <command> [args]

Commands:
  create-window [--url URL] [--incognito] [--focused]
                            Create new window
  create-tab                Create new background tab
  close-tab  <tabId>        Close a tab
  attach     <tabId>        Attach debugger
  detach     <tabId>        Detach debugger
  cdp        <tabId> <method> [params]   Execute CDP command
  screenshot <tabId> [--format png|jpeg] [--quality N]   Capture screenshot (base64)
  click      <tabId> <x> <y> [--double]                  Click at coords
  type       <tabId> <text>                              Type text
  keypress   <tabId> <key>                               Press a key
  move       <tabId> <x> <y>                             Move cursor
  drag       <tabId> "x1,y1 x2,y2 ..."                   Drag along path
  download-media <tabId> <x> <y>                         Download media at coords
  history    <tabId> [back|forward|goto|state] [index]    Navigate history
  scroll     <tabId> [--dx N] [--dy N]                    Scroll
  user-tabs                   List user tabs
  activate   <tabId>          Activate tab
  session                     Show session state
  status                      Connection health check
  find-element <tabId> [--text TEXT] [--selector CSS]     Find DOM element
  get-text   <tabId> [--max-length N]                     Extract page text
  snapshot   <tabId> [-d N]                               AX tree snapshot
  click-ref  <tabId> <nodeId>                             Click by ref
  finalize   [tabIds...]                                  Close tabs except listed
  wait-for   <tabId> <event> [--timeout N]                Wait for CDP event
  ping                          Verify connectivity
  read-page <url> [--raw|--text]  Read page (HTTP first, CDP fallback). --raw=HTML, --text=plain, default=defuddle
`;

function printUsage() {
  console.error(USAGE);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === "-h" || cmd === "--help") printUsage();

  // read-page uses its own RPC (for CDP fallback)
  if (cmd === "read-page") {
    const args2 = args.slice(1);
    let mode: ReadMode = "defuddle";
    let url = "";
    for (const a of args2) {
      if (a === "--raw") { mode = "raw"; }
      else if (a === "--text") { mode = "text"; }
      else if (a.startsWith("http")) { url = a; }
    }
    if (!url) { console.error("Error: url required"); process.exit(1); }
    await cmd_readPage(url, mode);
    return;
  }

  const rpc = new ShuntRPC();
  try {
    switch (cmd) {
      case "create-window": {
        const opts: Record<string, unknown> = {};
        for (let i = 1; i < args.length; i++) {
          if (args[i] === "--url" && args[i + 1]) opts.url = args[++i];
          else if (args[i] === "--incognito") opts.incognito = true;
          else if (args[i] === "--focused") opts.focused = args[++i] !== "false";
        }
        await cmd_createWindow(rpc, opts); break;
      }

      case "create-tab":
        await cmd_createTab(rpc); break;

      case "close-tab": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        await cmd_closeTab(rpc, tid); break;
      }

      case "attach": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        await cmd_attach(rpc, tid); break;
      }

      case "detach": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        await cmd_detach(rpc, tid); break;
      }

      case "cdp": {
        const tid = Number(args[1]);
        const method = args[2];
        if (!tid || !method) { console.error("Error: tab_id method [params] required"); process.exit(1); }
        await cmd_cdp(rpc, tid, method, args[3]); break;
      }

      case "screenshot": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        const opts: Record<string, unknown> = { tab_id: args[1] };
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--format" && args[i + 1]) opts.format = args[++i];
          else if (args[i] === "--quality" && args[i + 1]) opts.quality = Number(args[++i]);
          else if (args[i] === "--clip" && args[i + 1]) opts.clip = args[++i];
        }
        await cmd_screenshot(rpc, opts); break;
      }

      case "click": {
        const tid = Number(args[1]), x = Number(args[2]), y = Number(args[3]);
        if (!tid || isNaN(x) || isNaN(y)) { console.error("Error: tab_id x y required"); process.exit(1); }
        const dbl = args.includes("--double");
        await cmd_click(rpc, tid, x, y, dbl); break;
      }

      case "type": {
        const tid = Number(args[1]);
        const text = args[2];
        if (!tid || text === undefined) { console.error("Error: tab_id text required"); process.exit(1); }
        await cmd_type(rpc, tid, text); break;
      }

      case "keypress": {
        const tid = Number(args[1]);
        const key = args[2];
        if (!tid || !key) { console.error("Error: tab_id key required"); process.exit(1); }
        await cmd_keypress(rpc, tid, key); break;
      }

      case "move": {
        const tid = Number(args[1]), x = Number(args[2]), y = Number(args[3]);
        if (!tid || isNaN(x) || isNaN(y)) { console.error("Error: tab_id x y required"); process.exit(1); }
        await cmd_move(rpc, tid, x, y); break;
      }

      case "drag": {
        const tid = Number(args[1]);
        const path = args[2];
        if (!tid || !path) { console.error("Error: tab_id path required"); process.exit(1); }
        await cmd_drag(rpc, tid, path); break;
      }

      case "download-media": {
        const tid = Number(args[1]), x = Number(args[2]), y = Number(args[3]);
        if (!tid || isNaN(x) || isNaN(y)) { console.error("Error: tab_id x y required"); process.exit(1); }
        await cmd_downloadMedia(rpc, tid, x, y); break;
      }

      case "history": {
        const tid = Number(args[1]);
        const dir = args[2] || "state";
        const idx = Number(args[3]) || 0;
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        await cmd_history(rpc, tid, dir, idx); break;
      }

      case "scroll": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        let dx = 0, dy = 500;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--dx" && args[i + 1]) dx = Number(args[++i]);
          else if (args[i] === "--dy" && args[i + 1]) dy = Number(args[++i]);
        }
        await cmd_scroll(rpc, tid, dx, dy); break;
      }

      case "user-tabs":
        await cmd_userTabs(rpc); break;

      case "activate": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        await cmd_activate(rpc, tid); break;
      }

      case "session":
        await cmd_session(rpc); break;

      case "status":
        await cmd_status(rpc); break;

      case "find-element": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        const opts: { text?: string; selector?: string } = {};
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--text" && args[i + 1]) opts.text = args[++i];
          else if (args[i] === "--selector" && args[i + 1]) opts.selector = args[++i];
        }
        await cmd_findElement(rpc, tid, opts); break;
      }

      case "get-text": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        let ml = 10000;
        for (let i = 2; i < args.length; i++) {
          if (args[i] === "--max-length" && args[i + 1]) ml = Number(args[++i]);
        }
        await cmd_getText(rpc, tid, ml); break;
      }

      case "snapshot": {
        const tid = Number(args[1]);
        if (!tid) { console.error("Error: tab_id required"); process.exit(1); }
        let depth = 4;
        for (let i = 2; i < args.length; i++) {
          if ((args[i] === "-d" || args[i] === "--depth") && args[i + 1]) depth = Number(args[++i]);
        }
        await cmd_snapshot(rpc, tid, depth); break;
      }

      case "click-ref": {
        const tid = Number(args[1]), nid = Number(args[2]);
        if (!tid || !nid) { console.error("Error: tab_id node_id required"); process.exit(1); }
        await cmd_clickRef(rpc, tid, nid); break;
      }

      case "finalize": {
        const keep = args.slice(1).map(Number).filter(n => !isNaN(n));
        await cmd_finalize(rpc, keep); break;
      }

      case "wait-for": {
        const tid = Number(args[1]), event = args[2];
        if (!tid || !event) { console.error("Error: tab_id event required"); process.exit(1); }
        let timeout = 30;
        for (let i = 3; i < args.length; i++) {
          if (args[i] === "--timeout" && args[i + 1]) timeout = Number(args[++i]);
        }
        try {
          // wait_for_event is not easily expressible via RPC call() — the
          // RPC client reads responses sequentially, so we filter CDP events.
          // For now, fall back to polling with getSession.
          console.error("Note: wait-for uses polling via CDP Runtime (event subscription not yet implemented in TypeScript client)");
          process.exit(1);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          process.exit(1);
        }
        break;
      }

      case "ping":
        await cmd_ping(rpc); break;

      default:
        console.error(`Unknown command: ${cmd}`);
        console.error("Run 'shunt --help' for usage.");
        process.exit(1);
    }
  } catch (e) {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  } finally {
    rpc.close();
  }
}

main().then(() => process.exit(0)).catch(() => process.exit(1));
