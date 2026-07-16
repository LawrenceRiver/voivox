# VOIVOX extension-first local release plan

## Product contract

VOIVOX ships as three surfaces over one local-first transcript format:

1. A Chrome extension that can capture the active tab silently and transcribe it without an API key or a desktop dependency.
2. An optional macOS desktop app that offers a session library, Codex MCP, and a separate experimental selected-App ASR feature.
3. A Codex MCP server that reads raw transcripts and writes derived text without overwriting the source transcript.

The product is bilingual (`zh-CN` and `en`), defaults to the system language, persists a visible manual override, and never presents cloud upload as a requirement.

## Browser-local transcription

- Quality mode: `onnx-community/whisper-base`, pinned revision `1846881b6b3a3024392c1eea3ad983695bc23925`, `q8`.
- Fast mode: `onnx-community/whisper-tiny`, pinned revision `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, `q8`.
- Models download on first use and stay in the browser cache; they are not bundled into the extension archive.
- Prefer WebGPU and fall back to WASM. Runtime WASM files are packaged with the extension so Manifest V3 does not execute remote code.
- Keep at most ten minutes of mono 16 kHz audio in memory. A failed transcription remains retryable without recapturing.
- Audio and transcript content stay local. Network access is limited to pinned model artifacts from Hugging Face.

## Automatic desktop discovery

- The desktop app first attempts `127.0.0.1:43817`.
- The App atomically publishes an owner-only connection record and installs an exact-ID Native Messaging host. Before returning the restricted token, that host verifies a fresh HMAC challenge against the live server and its exact loopback address.
- The restricted extension token can import only a completed text transcript and is distinct from the desktop/MCP bearer token; no Chrome audio endpoint exists.
- If the fixed port is occupied, the desktop App falls back to an ephemeral loopback port. Native Messaging reports that actual, freshly proved address, so text-only sync and MCP continue without a manual pairing screen.
- Chrome tab audio always uses browser-local transcription. If the App is open, the extension auto-syncs only the completed text; selected-macOS-App capture remains a separate desktop feature.

## Delivery slices and gates

1. Unicode-path Electron startup regression test and fix.
2. Typed bilingual catalog with locale persistence.
3. Fixed-port discovery, exact-origin CORS, and restricted bootstrap token.
4. Browser-local model selection, download progress, capture lifecycle, retry, and transcript export.
5. Simplified bilingual desktop and popup UI with visible VOIVOX branding.
6. MCP raw/derived transcript workflow and a reproducible demo fixture.
7. Build, typecheck, unit/integration tests, unpacked-extension browser test, packaged-app smoke test, README screenshots, and GitHub release handoff.

No slice is called complete until its focused tests and the full existing suite both pass from the repository's real Unicode path.
