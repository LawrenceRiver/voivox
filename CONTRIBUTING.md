# Contributing to VOIVOX

VOIVOX has three deployable surfaces: the macOS desktop App, its local Codex MCP wrapper, and a Chrome extension. Keep changes local-first and explicit about which surface receives source audio.

## Before opening a pull request

1. Run `npm test`, `npm run typecheck`, `npm run build`, and `(cd native/macos && swift test)`.
2. Do not commit downloaded ASR models, `node_modules`, `dist`, `release`, `.build`, tokens, recordings, or `~/Library/Application Support/VOIVOX` data.
3. Preserve the raw-transcript rule: transforms are saved as a new derived result and never replace timestamped raw text.
4. Treat capture starts/stops and any external-provider call as explicit user actions. Do not add silent background capture, clipboard interception, or input-method hooks.

## Scope notes

- The desktop App is the authority for sessions and the authenticated loopback bridge.
- MCP remains a `stdio` wrapper around the running local App; it must never print the desktop bearer token.
- The extension can capture only a tab after a direct Chrome user gesture and can never receive the desktop bearer token.
- Keep source audio local by default. An optional provider may receive only text the user deliberately exports or transforms.
