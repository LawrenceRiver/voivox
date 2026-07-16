# Contributing to VOIVOX

VOIVOX has three deployable surfaces: the macOS desktop App, its local Codex MCP wrapper, and a Chrome extension. Keep changes local-first and explicit about which surface receives source audio.

## Before opening a pull request

1. Run `npm test`, `npm run typecheck`, `npm run build`, and `(cd native/macos && swift test)`.
2. Do not commit downloaded ASR models, `node_modules`, `dist`, `release`, `.build`, tokens, recordings, or `~/Library/Application Support/VOIVOX` data.
3. Preserve the raw-transcript rule: transforms are saved as a new derived result and never replace timestamped raw text.
4. Treat capture starts/stops and any external-provider call as explicit user actions. Do not add hidden background capture, clipboard interception, or input-method hooks.
5. Do not add remotely hosted executable code to the MV3 extension. Models may be downloaded as pinned data; JavaScript, AudioWorklets, WASM glue, and workers must ship in the extension archive.

## Scope notes

- The extension must remain useful without the desktop App. Its completed state and transcript stay in Chrome local storage.
- When the App is open, it is the authority for durable cross-surface sessions and the authenticated loopback bridge. Browser-local audio is never synchronized—only completed text.
- MCP remains a `stdio` wrapper around the running local App; it must never print the desktop bearer token.
- The extension can capture only a tab after a direct Chrome user gesture. It may receive only the restricted extension token through the exact-ID Native Messaging host after live-server proof; it can never receive the desktop/MCP token.
- Keep source audio local by default. An optional provider may receive only text the user deliberately exports or transforms.
