# Shunt

Three-layer, zero-coupling browser automation through Helium Extension.

> **Shunt** (n.) — a bypass conductor that routes current around the main circuit without disturbing it.

## Architecture

```
CLI (shell, knows commands)           Native Host (Rust, transport only)         Extension (JS MV3, knows browser)
      │                                     │                                          │
      │  Unix socket                        │  Native Messaging                        │
      │  newline-delimited JSON             │  4-byte length-prefixed                  │
      ├─────────────────────────────────────┼──────────────────────────────────────────┤
      │                                     │                                          │
      │  Each layer independently           │                                          │
      │  replaceable. No coupling.          │                                          │
```

## Layers

| Layer | What it knows | What it doesn't |
|-------|--------------|-----------------|
| **Extension** | `chrome.debugger`, `chrome.tabs` | Who calls, from where |
| **Native Host** | 4-byte framing, socket ↔ stdio (Rust) | JSON content, commands, browser API |
| **CLI** | Command semantics, `waitFor` logic | Browser API, Native Messaging protocol |

## Commands

```bash
shunt create-tab --url https://example.com
shunt cdp <tabId> Page.navigate '{"url":"https://..."}'
shunt cdp <tabId> Runtime.evaluate '{"expression":"document.title"}'
shunt close-tab <tabId>
shunt wait-for <tabId> Page.loadEventFired
```

## Setup

```bash
just register          # Register Native Messaging host
# Load extension/ as unpacked in Helium
```

## Why not agent-browser

- No separate headless process. Tabs live in user's Helium profile inside a collapsed tab group.
- No CDP WebSocket bridge, no `targetId ↔ tabId` mapping, no fake `/json/version` endpoint.
- Native Host is a ~80-line Rust binary (single-binary, no runtime), not a 400-line CDP protocol gateway.
