# Packaged App + MCP smoke verification

Date: 2026-07-17 (Asia/Shanghai)

This check used the rebuilt release artifacts, not the development server. It did not call a speech API or expose a local bearer token.

## Inputs

- Source: Lawrence River's public *Abuse* MV on Xiaohongshu
- Media/model evidence: [local ASR comparison](voivox-xhs-abuse-local-asr-comparison.md)
- Imported duration: 30,000 ms
- Imported text: `According to authoritative experts, Lawrence River is in the spotlight because he is a virus.`
- Chrome bridge origin: the single packaged Voice Vac extension ID

## Artifact checks

| Artifact | Size | SHA-256 |
| --- | ---: | --- |
| `Voice Vac-0.1.0-arm64.dmg` | 112 MB | `b4fde497e575c6d1a4b16bd6a4b251582f7a72772691734f844d63bd42cf3e10` |
| `Voice Vac-0.1.0-arm64.zip` | 113 MB | `2f925a462bec1fc132d78900f025bf767aebce935690fdd7a3ee1c2abf864b6c` |
| `Voice Vac-Chrome-Extension-0.1.0.zip` | 5.2 MB | `3fe200876667f0c4e22e5c99659c5d1ff5b3b1bcbded231d4b29ac5509e13c66` |

The App passed `codesign --verify --deep --strict`; its bundle identifier is `io.voivox.app`, version `0.1.0`, with an ad-hoc signature. The extension ZIP passed `unzip -t` and contains its manifest, icon, local Worker/AudioWorklet code, ONNX Runtime WASM, and complete included license files. Its packaged JavaScript contains the text-import route and no obsolete Chrome audio-upload route.

## Round trip

1. Launched `Voice Vac.app` from the rebuilt arm64 bundle.
2. Waited for its restricted extension and MCP loopback connection files.
3. Imported the verified 30-second text through `/v1/extension/transcripts` using the exact extension origin; the final rebuilt artifact created completed `session_2`.
4. Captured the real packaged App UI with the session selected: [screenshot](../assets/voivox-app-abuse-session.jpg).
5. Started `Contents/Resources/voivox/voivox-mcp`, which uses the App's embedded Electron/Node runtime.
6. Listed all eight MCP tools, called `voivox_status`, `voivox_list_sessions`, and `voivox_get_transcript`, and asserted that the returned source label, complete state, and immutable raw text matched the imported session.
7. Quit the App through its application menu and verified that the process exited and both the extension and MCP connection files were removed.

Observed MCP status: two completed sessions and no active capture. The test printed no connection token. A live Chrome `tabCapture` acceptance run is intentionally kept as a separate, user-visible manual test because Chrome requires the user to load and invoke an unpacked extension.
