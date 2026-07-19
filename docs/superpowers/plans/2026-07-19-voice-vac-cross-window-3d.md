# Voice VAC Full Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the referenced plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the visible Electron prototype with the approved native Voice VAC desktop device, ship separate Store and Automation Chrome extensions, and make local Qwen transcription and `transcribe_active_video` work end to end.

**Architecture:** A macOS 26 AppKit/RealityKit App renders the Liquid Glass capsule, 3D device, transparent per-screen hose overlays, and transcript bubble. A hidden local bridge preserves the tested loopback, transcript store, ASR, and MCP contracts. Chrome ships two physically separate MV3 bundles that share session logic but have different permissions and playback drivers.

**Tech Stack:** Swift 6.3, AppKit, `NSGlassEffectView`, RealityKit, Metal fallback, XcodeGen/Xcode 26, Blender 5.2 LTS, TypeScript, Chrome MV3, Native Messaging, Node 25, a dedicated Python 3.12 ASR environment, Qwen3-ASR, MCP SDK, Vitest, Swift Testing, Computer Use.

## Global Constraints

- User-visible brand is exactly `Voice VAC`; existing internal compatibility identifiers remain unchanged during the first native migration.
- The visible App requires macOS 26 and Apple Silicon; current macOS 14 CLI helpers remain compatible.
- No cloud transcription API, microphone capture, system-audio capture, DRM bypass, login bypass, or paid-content bypass.
- Invalid drops remain where released in `warningYellow`; they never auto-retract.
- Capture starts only after the target is `ready` and the user presses the red button.
- Store Extension contains no `debugger` permission or CDP code. Automation Extension is a physically separate build and includes `debugger`.
- The selected target is always bound to its stored `tabId + documentId`; changing the active tab cannot redirect capture.
- Tests are written and observed failing before production changes. Every task ends with focused tests and a commit.
- Existing Electron code is retained as a diagnostic/back-end migration aid until the native App passes functional equivalence; it is not the final visible UI.
- No production fallback may silently replace missing 3D assets with primitive cylinders, spheres, CSS tubes, or SVG hoses.

---

## Execution Order

### Plan A: Native App and 3D runtime

Read and execute:

```text
docs/superpowers/plans/2026-07-19-voice-vac-native-app.md
```

Deliverable: a directly runnable `Voice VAC.app` with no Dock icon, a `406 × 116 pt` system-glass capsule, independent transcript/nozzle/overlay panels, tested state reducer, active-length hose solver, and RealityKit asset contract.

### Plan B: Store and Automation extensions

Read and execute:

```text
docs/superpowers/plans/2026-07-19-voice-vac-chrome-dual-build.md
```

Deliverable: two installable ZIPs with fixed target-tab sessions, native external drop targeting, Store autoplay fallback, and Automation CDP playback without moving the system cursor.

### Plan C: Local ASR, bridge, and MCP

Read and execute:

```text
docs/superpowers/plans/2026-07-19-voice-vac-local-asr-mcp.md
```

Deliverable: request-safe Qwen worker startup, incremental local transcript flow, App-to-Extension commands, a real `transcribe_active_video` trigger/wait/result cycle, and shared structured error codes.

### Plan D: Visual QA, packaging, and real-video proof

Read and execute:

```text
docs/superpowers/plans/2026-07-19-voice-vac-release-validation.md
```

Deliverable: Blender and Computer Use evidence, target-tab isolation tests, real Chrome video transcription, DMG, two Extension ZIPs, MCP launcher, screenshots, architecture diagram, and release documentation.

## Pre-flight Decisions

- Repository work is isolated on branch `codex/voice-vac-native`.
- Commit `f7417ff` is the preserved pre-native checkpoint for the 92 existing PVTT changes.
- Baseline Swift tests: 19 passing.
- Baseline JS tests: 260 passing, one flaky Qwen worker timeout test. Plan C Task 1 fixes the root cause before it can be counted as a clean baseline.
- Existing Store Extension ID remains `pepfpbobjbjehhhcjiokmneclohlffno`.
- Automation Extension ID is `ciijinidnlbokpbeiabifcnoighmbnmh`, derived from its separate manifest public key.
- Visible App Bundle ID remains `io.voivox.app`; Native Messaging host remains `com.voivox.bridge`.

## Whole-product completion gate

- [ ] `npm test`, `npm run typecheck`, `npm run build`, and `swift test --package-path native/macos` pass with no unhandled errors.
- [ ] Xcode App unit/UI tests pass and `Voice VAC.app` launches with `LSUIElement=true`.
- [ ] Store bundle byte scan proves no debugger/CDP code; Automation bundle proves the permission and driver exist.
- [ ] The nozzle can be dragged from the App to a real Chrome video, released into `ready`, started by the red button, paused/resumed, and retracted only by `×`.
- [ ] Switching to another tab or app after attachment does not change the captured tab.
- [ ] Other tabs, Spotify, Logic Pro, system output devices, and microphone do not enter the transcript.
- [ ] `transcribe_active_video` returns the armed video transcript, title, URL, language, processing mode, and stable error codes.
- [ ] App, Store ZIP, Automation ZIP, and MCP launcher are packaged and their checksums recorded.
- [ ] README and hackathon materials distinguish verified behavior from experimental accelerated-media behavior.
