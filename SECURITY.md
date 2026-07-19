# Security policy

## Supported line

The current pre-1.0 branch is supported while it is actively maintained. Distribution builds are macOS arm64 only.

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting form](https://github.com/LawrenceRiver/voivox/security/advisories/new) rather than opening a public issue. Include reproduction steps, affected version, and whether the issue can expose recordings, transcripts, local tokens, model files, or capture without a user action. Never include a live token or a real private recording in the report.

## Security properties

- The desktop bridge binds only to `127.0.0.1`. Its primary API uses a per-launch bearer token.
- The Chrome extension has a narrower token that can only import a completed text transcript; it cannot submit audio, read sessions, or call primary/MCP endpoints.
- Native Messaging is restricted to Voice Vac's stable extension ID. Before the host releases the restricted token, it verifies a fresh HMAC challenge against the live loopback server and its exact address; stale crash files or port relays do not pass.
- Before every bearer-authenticated MCP request, the bundled MCP client proves the current primary token with a fresh random HMAC challenge bound to the exact loopback address. A stale or relayed connection file therefore cannot release the bearer token to the wrong listener.
- Native Messaging and extension connection files are atomically written with user-only permissions. The MCP connection file is also user-only, is removed during a clean App shutdown, and remains protected by the per-request HMAC proof after a crash. Neither token is returned by an MCP tool or unauthenticated HTTP route.
- Chrome tab capture requires a direct user gesture. Browser ASR code/WASM ships inside the extension; only pinned model data is downloaded remotely.
- Chrome tab audio always stays inside the extension for browser-local Fast/Quality Whisper transcription. Opening the optional App changes only the destination of the completed text: it may auto-sync through the authenticated `127.0.0.1` text-import route. The restricted bridge exposes no Chrome capture, audio-chunk, or stop endpoint.
- The selected-App Core Audio helper monitors its dedicated parent pipe. Parent EOF and normal SIGINT share an idempotent teardown, preventing an orphaned helper from continuing capture or leaving the selected process muted after an App crash. Desktop shutdown isolates each cleanup failure so one failed step cannot skip later ASR, tap-host, loopback, or connection-file cleanup.
- Raw transcripts remain local by default. Voice Vac and its MCP do not upload audio to an LLM. If a user asks Codex to read or transform MCP transcript text, that text may be processed by the model provider selected in Codex under that provider's terms and settings.

Do not attach real recordings, bearer tokens, bridge tokens, or API keys to an issue or pull request.
