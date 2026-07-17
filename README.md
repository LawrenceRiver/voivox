# VOIVOX

<p align="center">
  <img src="docs/assets/voivox-cover.png" width="240" alt="VOIVOX stop-motion audio-to-text mascot" />
</p>

<p align="center">
  <strong>Let playing audio become useful text—quietly, locally, and without taking over dictation.</strong>
</p>

<p align="center">
  <a href="https://github.com/LawrenceRiver/voivox/actions/workflows/verify.yml"><img src="https://github.com/LawrenceRiver/voivox/actions/workflows/verify.yml/badge.svg" alt="Verification" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-0B6B6B.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/ASR-no%20API-0B6B6B.svg" alt="No speech API" />
  <img src="https://img.shields.io/badge/privacy-local--first-0B6B6B.svg" alt="Local first" />
</p>

VOIVOX captures only the source you choose, keeps the host muted, and transcribes with an open model on the device. The Chrome extension works by itself. The macOS App connects automatically when present, preserves a local transcript library, and packages a Codex MCP so an agent can read or transform the text without touching the immutable source.

<p align="center">
  <img src="docs/assets/voivox-overview.png" width="100%" alt="Chrome Extension, VOIVOX App, and Codex MCP connected by one local-first workflow" />
</p>

## Three surfaces, one job

| Surface | What it does | Needs the App? |
| --- | --- | --- |
| Chrome Extension | One-click muted capture of the active tab; local Fast/Quality Whisper transcription; copy/retry; Chinese/English UI | No |
| macOS App | Automatic extension bridge, durable local sessions, experimental selected-App capture, local capability status | — |
| Codex MCP | Lists sessions, reads/exports raw text, starts/stops an explicitly selected macOS source, and stores derived text separately | Yes |

No cloud speech API or API key is required. VOIVOX does not hook the keyboard, clipboard, microphone dictation channel, Doubao, WeChat, or the system input method.

## Real no-API smoke test: *Abuse* MV

<p align="center">
  <a href="https://www.xiaohongshu.com/explore/699ee564000000001b01624a"><img src="docs/assets/voivox-case-abuse-mv.jpg" width="100%" alt="Frame from Lawrence River's Abuse music video used for VOIVOX local transcription verification" /></a>
</p>

The user's public Xiaohongshu MV has no native caption track, so VOIVOX extracted the first 30 seconds as 16 kHz mono audio and ran both pinned q8 models locally. Fast and Quality returned the same unedited text:

> According to authoritative experts, Lawrence River is in the spotlight because he is a virus.

The visible opening card supports the final clause, but this is a smoke test—not a word-error-rate claim. The recorded run used **no speech API**: Fast was warm-cached; Quality downloaded its model once, then inference ran on the local CPU. Exact revisions, hashes, cache conditions, raw outputs, and timings are preserved in the [comparison record](docs/evidence/voivox-xhs-abuse-local-asr-comparison.md) and its linked JSON evidence.

<p align="center">
  <img src="docs/assets/voivox-app-abuse-session.jpg" width="100%" alt="Packaged VOIVOX macOS App showing the imported Abuse MV transcript and ready Codex MCP" />
</p>

The rebuilt packaged App then accepted that transcript through its restricted Chrome bridge. Its bundled MCP launcher—using the App's embedded Node runtime—listed the local session and read back the same immutable text. The [packaged App + MCP smoke record](docs/evidence/voivox-packaged-app-mcp-smoke.md) preserves the artifact hashes, assertions, and privacy-safe result.

### Live Chrome tab-capture acceptance

<p align="center">
  <img src="docs/assets/voivox-live-tab-transcription.jpg" width="420" alt="VOIVOX Chrome extension showing a completed local transcription from a live Xiaohongshu tab" />
</p>

The unpacked extension was also invoked through the real Chrome UI against a playing Xiaohongshu video. It muted host playback, captured the tab audio, downloaded the pinned Quality model, ran q8 Whisper through bundled ONNX Runtime WASM, and displayed the completed raw text above. This acceptance run found and fixed two Chrome-only lifecycle bugs that unit mocks had missed. The [live tab-capture record](docs/evidence/voivox-live-tab-capture.md) documents the reproduction, fix, and limitations of this noisy music-video sample.

## Judge / first-use path

Download the latest judge artifacts from [GitHub Releases](https://github.com/LawrenceRiver/voivox/releases), then:

1. Unzip `VOIVOX-Chrome-Extension-0.1.1.zip`.
2. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the unzipped folder.
3. Pin VOIVOX, open a playing tab, choose **Fast** or **Quality**, and click the large capture button.
4. Stop capture to get text. The first run downloads and caches the selected pinned model; transcription itself stays local.
5. Optionally drag `VOIVOX.app` into `/Applications` and open it. The extension discovers it automatically—there is no address or token pairing screen.

The current App candidate is ad-hoc signed for bundle integrity, but it is not Developer ID signed or notarized. macOS may require right-clicking it and choosing **Open** once. See the [release runbook](docs/release/RELEASE.md) for exact artifact and Gatekeeper notes.

### Local model modes

| Mode | Pinned model | Approx. first download | Best for |
| --- | --- | ---: | --- |
| Fast | `onnx-community/whisper-tiny` q8 | 45 MB | quick drafts and shorter clips |
| Quality | `onnx-community/whisper-base` q8 | 80 MB | better multilingual recognition |

Each model is pinned to an exact repository revision in source. VOIVOX deliberately runs the compact q8 models through bundled single-thread ONNX Runtime WASM; current Transformers.js guidance does not recommend q8 Whisper on WebGPU. A capture is limited to ten minutes; model memory is released after inactivity. During model download or transcription, the same main button cancels the work. Cancelled, failed, or timed-out audio remains only in extension memory for Retry and is cleared after success, a new capture, extension reload/update, or Chrome exit.

## Codex MCP

The macOS App contains a bundled MCP server and launches it with Electron's embedded Node runtime, so the release build does not require a separate Node installation.

After installing the App in `/Applications`, run:

```bash
codex mcp add voivox -- /Applications/VOIVOX.app/Contents/Resources/voivox/voivox-mcp
```

Open VOIVOX before using the tools. Useful first calls are:

- `voivox_status`
- `voivox_list_sessions`
- `voivox_get_transcript`
- `voivox_export_transcript`
- `voivox_save_derived_text`

Browser-local captures sync **completed text only** to the running App. Audio remains inside the extension. Codex can generate a summary, outline, translation, or cleanup as a derived result; it never overwrites timestamped raw text.

For development instead of an installed App:

```bash
npm run build --workspace=@voivox/mcp
codex mcp add voivox-dev -- node /absolute/path/to/voivox/apps/mcp/dist/index.js
```

## Development

Requirements:

- Node.js 22+
- Swift 6+ and macOS 15+ for the native App hosts
- Chrome 116+ for tab capture/offscreen APIs
- Apple Silicon for the current packaged desktop target

```bash
git clone https://github.com/LawrenceRiver/voivox.git
cd voivox
npm install
npm test
npm run typecheck
npm run build
```

Start the App from source:

```bash
npm run start --workspace=@voivox/desktop
```

Build the standalone extension:

```bash
npm run build --workspace=@voivox/chrome-extension
```

Load `apps/chrome-extension/dist` in Chrome. The stable extension key produces ID `pepfpbobjbjehhhcjiokmneclohlffno`, which is also the only extension origin accepted by the native host and restricted loopback routes.

### Optional desktop ASR

Chrome does not need the desktop Python runtime. The optional selected-macOS-App path currently uses `mlx-qwen3-asr` and is clearly labeled **Experimental** in the UI:

```bash
bash scripts/install-asr-runtime.sh
```

This runtime is stored outside the repository and is not embedded in release artifacts. Until real capture, permissions, and non-empty text are confirmed on the target Mac, selected-App capture should not be presented as production-stable.

## Architecture and trust boundaries

```text
User click
  └─ Chrome tabCapture → zero-gain Web Audio graph → 16 kHz mono buffer
       └─ bundled Transformers.js + WebGPU/WASM → browser-local text
            └─ optional open App: completed text only (never audio)
                 └─ exact-ID discovery + HMAC proof → local sessions.json → Codex MCP

Separate desktop feature
  └─ explicitly selected macOS App → experimental local Qwen ASR → local session
```

Security properties are tested rather than implied:

- Native Messaging is restricted to the stable extension ID.
- A fresh random challenge and HMAC bind discovery to the live server's exact `127.0.0.1` address; a stale crash file or relayed port cannot release the token.
- The extension token can import only a completed browser transcript; it cannot accept audio, list/read sessions, use MCP routes, or access the App's primary token.
- MV3 JavaScript, Worker code, AudioWorklet code, and WASM are packaged locally. Only pinned model **data** is downloaded.
- Capture start requires a user gesture, and the extension recovers from stale MV3/offscreen state.
- Raw and derived text are stored separately.

Read [PRIVACY.md](PRIVACY.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the full boundary and dependency details.

## Repository layout

```text
apps/desktop           Electron desktop App and packaged MCP launcher
apps/chrome-extension  Chrome MV3 popup, offscreen capture, local ASR Worker
apps/mcp               stdio MCP server and local VOIVOX client
packages/core          session model, persistence, authenticated loopback API
packages/i18n          typed Chinese/English message catalog
native/macos           selected-process host and Native Messaging verifier
native/asr             optional desktop Python ASR worker
docs                   design, hackathon, release, and visual assets
```

## Verification and packaging

```bash
npm test
npm run typecheck
npm run build
(cd native/macos && swift test)
npm run package:zip --workspace=@voivox/chrome-extension
npm run package:mac --workspace=@voivox/desktop
```

The suite covers core access control, persistence, Native Messaging framing/proof, extension identity, audio buffering, lifecycle recovery, model switching, worker errors, bilingual UI state, MCP tools, and distributable build contents. The recorded *Abuse* MV check verifies the real media-to-pinned-local-model path without a speech API, and the rebuilt App artifact plus its bundled MCP passed a real local session round trip. Loading the packaged extension into Chrome and capturing a live tab remains the final manual browser acceptance check.

## OpenAI Build Week

VOIVOX was meaningfully extended during the July 13–21, 2026 submission period as a non-trivial Codex collaboration: product architecture, TDD implementation, Swift/TypeScript security hardening, local-model integration, bilingual UX, independent review, release-gate testing, and reproducible local-model verification were carried out in the primary Codex build task and recorded in dated commits.

The submission checklist and under-three-minute demo storyboard are in [docs/hackathon/OPENAI_BUILD_WEEK.md](docs/hackathon/OPENAI_BUILD_WEEK.md). The Devpost entry must still include the public YouTube demo and the `/feedback` Session ID from the primary Codex task.

## License

VOIVOX source is released under the [MIT License](LICENSE). Third-party components and separately downloaded model data retain their own terms.
