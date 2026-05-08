// Shunt overlay — visual cursor feedback for agent-browser tabs
// Injected dynamically on attach, draws a fading red dot at click positions

(() => {
  let cursor = null;
  let ring = null;
  let highlightRects = [];

  function ensureElements() {
    if (!document.body) return false;
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.id = '__shunt_cursor';
      cursor.style.cssText = `
        position: fixed;
        width: 16px; height: 16px;
        border: 2px solid #ff4444;
        background: rgba(255,68,68,0.15);
        border-radius: 50%;
        pointer-events: none;
        z-index: 2147483647;
        transform: translate(-50%,-50%);
        opacity: 0;
        transition: opacity 0.12s ease-out;
      `;
      document.body.appendChild(cursor);
    }
    if (!ring) {
      ring = document.createElement('div');
      ring.id = '__shunt_ring';
      ring.style.cssText = `
        position: fixed;
        width: 36px; height: 36px;
        border: 2px solid rgba(255,68,68,0.45);
        border-radius: 50%;
        pointer-events: none;
        z-index: 2147483646;
        transform: translate(-50%,-50%) scale(0.6);
        opacity: 0;
        transition: opacity 0.25s ease-out, transform 0.25s ease-out;
      `;
      document.body.appendChild(ring);
    }
    return true;
  }

  function showCursor(x, y) {
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
    cursor.style.opacity = '1';
    ring.style.left = x + 'px';
    ring.style.top = y + 'px';
    ring.style.transform = 'translate(-50%,-50%) scale(1)';
    ring.style.opacity = '1';

    setTimeout(() => {
      cursor.style.opacity = '0';
      ring.style.transform = 'translate(-50%,-50%) scale(1.8)';
      ring.style.opacity = '0';
    }, 700);
  }

  function highlightElement(rect) {
    const el = document.createElement('div');
    el.style.cssText = `
      position: fixed;
      left: ${rect.x}px;
      top: ${rect.y}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      border: 2px solid #44aaff;
      background: rgba(68,170,255,0.08);
      pointer-events: none;
      z-index: 2147483645;
      transition: opacity 0.3s;
    `;
    if (!document.body) return;
    document.body.appendChild(el);
    highlightRects.push(el);
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 300);
    }, 2000);
    return el;
  }

  function clearHighlights() {
    for (const el of highlightRects) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    highlightRects = [];
  }

  let injected = false;

  function ensure() {
    if (injected) return;
    // Wait for body
    if (!ensureElements()) {
      setTimeout(ensure, 50);
      return;
    }
    injected = true;
  }

  // Start trying — body might not exist yet
  ensure();

  // Listen for messages from extension
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.from !== 'shunt') return;

    switch (msg.action) {
      case 'showCursor':
        ensure();
        showCursor(msg.x, msg.y);
        break;

      case 'highlight':
        ensure();
        if (msg.rect) highlightElement(msg.rect);
        break;

      case 'clearHighlights':
        clearHighlights();
        break;
    }
  });
})();
