# Voice VAC Release Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 5–8 additionally require `computer-use` and `chrome:control-chrome` for real macOS/Chrome evidence; screenshots or videos created without those real interactions do not satisfy the gate.

**Goal:** Validate the completed Voice VAC native App, Store Extension, Automation Extension, local Qwen ASR, and Codex MCP on a real Apple Silicon Mac, then produce one DMG, two Extension ZIPs, checksums, visual evidence, documentation, and a draft GitHub release for version `0.2.0`.

**Architecture:** Release validation consumes the products implemented by Plans A–C and adds a deterministic release contract, evidence schemas, byte-level package scanners, real Chrome fixtures, hardware diagnostics, and clean-install scripts. Automated JSON evidence proves reproducible properties; dated Markdown, screenshots, and Computer Use recordings prove interactions that cannot be established by unit tests.

**Tech Stack:** Blender 5.2 LTS, a dedicated Python 3.12 ASR environment, Swift 6.3, AppKit, RealityKit, Xcode 26, Node.js 22+, TypeScript, Chrome MV3, FFmpeg, Qwen3-ASR-0.6B, MCP SDK, Vitest, Swift Testing, Computer Use, Chrome control, GitHub Actions, `codesign`, `hdiutil`, `shasum`, and `gh`.

## Global Constraints

- User-visible brand is exactly `Voice VAC`; internal compatibility identifiers such as `@voivox/*`, `VOIVOX_*`, `io.voivox.app`, `com.voivox.bridge`, and the existing Store Extension ID remain unchanged.
- Release version is exactly `0.2.0`; tag is exactly `v0.2.0`.
- Release machine is Apple Silicon running macOS 26 with Xcode 26, Blender 5.2 LTS, Google Chrome 116 or later, Node.js 22 or later, a Python 3.12 ASR environment, and FFmpeg available on `PATH`.
- Plan A (`2026-07-19-voice-vac-native-app.md`), Plan B (`2026-07-19-voice-vac-chrome-dual-build.md`), and Plan C (`2026-07-19-voice-vac-local-asr-mcp.md`) must be complete before Task 1 begins.
- The visible App is `LSUIElement=true`, Apple Silicon only, requires macOS 26, and has no ordinary titled main window or Dock icon.
- Blender delivery must contain a true skinned corrugated hose with exactly 64 ordered deform joints, a rectangular duckbill nozzle, rotary collar, physical red button cap/base, PBR materials, and the deterministic nozzle/button actions required by the locked design.
- The hose is validated as an active-length orientation-based rod; the release may not substitute a CSS path, SVG curve, primitive cylinder, or unskinned static tube.
- Store Extension permissions are exactly `activeTab`, `nativeMessaging`, `offscreen`, `scripting`, `storage`, and `tabCapture`; neither its manifest nor any unpacked byte may contain `debugger` or Chrome DevTools Protocol playback code.
- Automation Extension is a physically separate bundle and must contain `debugger` plus its CDP playback driver; it may not share the Store Extension ID.
- Store Extension ID is `pepfpbobjbjehhhcjiokmneclohlffno`; Automation Extension ID is `ciijinidnlbokpbeiabifcnoighmbnmh`.
- Capture begins only after the target tab is armed, the nozzle is attached, the product reaches `ready`, and the user presses the physical red button.
- Only the bound `tabId + documentId` may be captured; changing the active tab or frontmost App may not redirect the session.
- No cloud speech API, microphone capture, full-system audio capture, keyboard hook, DRM bypass, login bypass, or paid-content bypass is permitted.
- Local ASR evidence uses `Qwen/Qwen3-ASR-0.6B`; model setup/download time is reported separately from inference time, and the evidence records hardware, model revision, cache state, duration, processing mode, and RTF.
- The rights-cleared platform demo is Lawrence River's own Xiaohongshu MV at `https://www.xiaohongshu.com/explore/699ee564000000001b01624a`; a deterministic local spoken-video fixture is also mandatory so isolation assertions do not depend on music or website state.
- Artifacts are exactly `Voice-VAC-0.2.0-arm64.dmg`, `Voice-VAC-Store-Extension-0.2.0.zip`, `Voice-VAC-Automation-Extension-0.2.0.zip`, and `SHA256SUMS.txt` under ignored directory `dist/release/`.
- The DMG is ad-hoc signed and not notarized because the repository contains no Developer ID credentials. `codesign --verify` must pass; Gatekeeper rejection must be recorded and described honestly rather than hidden.
- Generated binaries and raw logs stay ignored under `dist/` or `/tmp`; curated Markdown, JSON, screenshots, and short evidence recordings live under `docs/evidence/release-0.2.0/`.
- No completion claim is allowed from automated tests alone. Each manual gate names the operator action, expected observable result, timestamp, artifact hash, and evidence path.
- Every task starts from a clean worktree, runs its focused gate, records its evidence, and ends with the exact commit shown in that task.

---

## File and Evidence Map

### Release harness

- `scripts/release/release-contract.mjs` — single source of truth for version, IDs, permissions, artifact names, model, and evidence paths.
- `scripts/release/preflight.mjs` — records toolchain, hardware, OS, Git revision, and clean-worktree state.
- `scripts/release/scan-extension-bundle.mjs` — unpacks and byte-scans Store/Automation ZIPs.
- `scripts/release/verify-release-artifacts.mjs` — verifies filenames, ZIP roots, signatures, required App resources, hashes, and package contents.
- `scripts/release/package-native-app.sh` — builds, ad-hoc signs, and creates the DMG without changing the product source.
- `scripts/release/generate-checksums.sh` — emits deterministic SHA-256 lines for the three public artifacts.
- `scripts/release/final-gate.sh` — runs the full non-interactive gate from a clean checkout.
- `scripts/release/capture-display-layout.swift` — records AppKit display frames, visible frames, backing scales, and coordinate origins.
- `scripts/release/capture-audio-devices.swift` — records Core Audio default input/output/system-output device UIDs.

### Deterministic real-browser fixture and MCP probe

- `tests/fixtures/voice-vac-video/index.html` — target spoken-video page.
- `tests/fixtures/voice-vac-video/distractor.html` — other-tab spoken-video page containing sentinel phrases that must never enter the target transcript.
- `scripts/e2e/make-spoken-video-fixtures.sh` — creates rights-safe bilingual MP4s in `/tmp/voice-vac-e2e-media/` using macOS voices and FFmpeg.
- `scripts/e2e/serve-video-fixtures.mjs` — serves both pages from `127.0.0.1:4178` with deterministic headers.
- `scripts/e2e/mcp-transcribe-active-video.mjs` — calls the packaged MCP over stdio and writes its exact structured result.

### Curated evidence

- `docs/evidence/release-0.2.0/README.md` — index of gates, pass/fail state, machine, commit, and evidence hashes.
- `docs/evidence/release-0.2.0/environment.json`
- `docs/evidence/release-0.2.0/blender-asset-qa.json`
- `docs/evidence/release-0.2.0/blender-asset-qa.md`
- `docs/evidence/release-0.2.0/native-overlay-qa.md`
- `docs/evidence/release-0.2.0/store-extension-scan.json`
- `docs/evidence/release-0.2.0/automation-extension-scan.json`
- `docs/evidence/release-0.2.0/real-chrome-video-e2e.md`
- `docs/evidence/release-0.2.0/multidisplay-qa.md`
- `docs/evidence/release-0.2.0/audio-isolation.json`
- `docs/evidence/release-0.2.0/audio-isolation.md`
- `docs/evidence/release-0.2.0/asr-mcp-e2e.json`
- `docs/evidence/release-0.2.0/asr-mcp-e2e.md`
- `docs/evidence/release-0.2.0/clean-install.md`
- `docs/evidence/release-0.2.0/assets/` — named screenshots and short recordings listed in Tasks 2–8.

### Public documentation and release metadata

- `README.md`
- `PRIVACY.md`
- `SECURITY.md`
- `THIRD_PARTY_NOTICES.md`
- `docs/assets/voice-vac-architecture.svg`
- `docs/assets/voice-vac-architecture.png`
- `docs/hackathon/OPENAI_BUILD_WEEK.md`
- `docs/release/RELEASE.md`
- `docs/release/v0.2.0.md`
- `docs/release/v0.2.0-checksums.md`
- `.github/workflows/verify.yml`
- `.github/workflows/package-macos.yml`

---

### Task 1: Freeze the release contract, evidence schema, and preflight gate

**Files:**
- Modify: `package.json`
- Create: `scripts/release/release-contract.mjs`
- Create: `scripts/release/release-contract.test.mjs`
- Create: `scripts/release/preflight.mjs`
- Create: `scripts/release/preflight.test.mjs`
- Create: `docs/evidence/release-0.2.0/README.md`

**Interfaces:**
- Produces `RELEASE_CONTRACT`, `assertReleaseContract()`, and `collectPreflight()` for every later release script.
- Writes machine-readable evidence only when `--json-output` is supplied; tests use a temporary output directory and never overwrite curated evidence.

- [ ] **Step 1: Write the failing release-contract tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { RELEASE_CONTRACT, assertReleaseContract } from './release-contract.mjs';

test('release 0.2.0 has exactly one DMG and two extension ZIPs', () => {
  assert.deepEqual(RELEASE_CONTRACT.artifacts, [
    'Voice-VAC-0.2.0-arm64.dmg',
    'Voice-VAC-Store-Extension-0.2.0.zip',
    'Voice-VAC-Automation-Extension-0.2.0.zip'
  ]);
  assert.equal(RELEASE_CONTRACT.tag, 'v0.2.0');
  assert.doesNotThrow(() => assertReleaseContract(RELEASE_CONTRACT));
});

test('Store and Automation permission contracts cannot converge', () => {
  assert.deepEqual(RELEASE_CONTRACT.extensions.store.permissions, [
    'activeTab', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture'
  ]);
  assert(!RELEASE_CONTRACT.extensions.store.permissions.includes('debugger'));
  assert(RELEASE_CONTRACT.extensions.automation.permissions.includes('debugger'));
  assert.notEqual(
    RELEASE_CONTRACT.extensions.store.id,
    RELEASE_CONTRACT.extensions.automation.id
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test scripts/release/release-contract.test.mjs scripts/release/preflight.test.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `release-contract.mjs` or `preflight.mjs`.

- [ ] **Step 3: Implement the immutable contract**

```js
export const RELEASE_CONTRACT = Object.freeze({
  productName: 'Voice VAC',
  version: '0.2.0',
  tag: 'v0.2.0',
  bundleID: 'io.voivox.app',
  model: 'Qwen/Qwen3-ASR-0.6B',
  artifacts: Object.freeze([
    'Voice-VAC-0.2.0-arm64.dmg',
    'Voice-VAC-Store-Extension-0.2.0.zip',
    'Voice-VAC-Automation-Extension-0.2.0.zip'
  ]),
  extensions: Object.freeze({
    store: Object.freeze({
      id: 'pepfpbobjbjehhhcjiokmneclohlffno',
      permissions: Object.freeze([
        'activeTab', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture'
      ])
    }),
    automation: Object.freeze({
      id: 'ciijinidnlbokpbeiabifcnoighmbnmh',
      permissions: Object.freeze([
        'activeTab', 'debugger', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture'
      ])
    })
  })
});
```

`assertReleaseContract()` must reject duplicate artifact names, an artifact outside `dist/release`, mismatched versions, Store `debugger`, equal Extension IDs, a non-64 joint count, or any product name other than `Voice VAC`.

- [ ] **Step 4: Implement preflight collection and tests**

`collectPreflight()` returns this stable shape:

```js
{
  schemaVersion: 1,
  recordedAt: 'ISO-8601',
  git: { commit: '40-hex', branch: 'codex/voice-vac-native', clean: true },
  machine: { architecture: 'arm64', cpu: '...', memoryBytes: 0 },
  software: {
    macOS: '26.x', xcode: '26.x', swift: '6.x', blender: '5.2.x',
    chrome: '116+', node: '22+', npm: '10+', python: '3.13.x', ffmpeg: '...'
  }
}
```

Reject `architecture !== 'arm64'`, macOS below 26, Xcode below 26, Blender outside 5.2.x, missing tools, a dirty worktree, or branch other than `codex/voice-vac-native`. The only branch exception is a detached clean worktree invoked with `--expected-commit <40-hex>` whose `HEAD` exactly matches that value. Add root scripts:

```json
{
  "release:test": "node --test scripts/release/*.test.mjs scripts/e2e/*.test.mjs",
  "release:preflight": "node scripts/release/preflight.mjs --json-output docs/evidence/release-0.2.0/environment.json"
}
```

- [ ] **Step 5: Run the focused tests and commit**

```bash
node --test scripts/release/release-contract.test.mjs scripts/release/preflight.test.mjs
git diff --check
git add package.json scripts/release/release-contract.mjs scripts/release/release-contract.test.mjs scripts/release/preflight.mjs scripts/release/preflight.test.mjs docs/evidence/release-0.2.0/README.md
git commit -m "test: define Voice VAC 0.2.0 release contract"
```

Expected: all focused tests PASS; the evidence index lists every gate as `Not run` without claiming validation.

---

### Task 2: Add the Blender 64-joint asset gate and complete visual QA

**Files:**
- Modify: `tools/blender/scripts/validate_voice_vac.py`
- Modify: `tools/blender/scripts/render_voice_vac_preview.py`
- Create: `tools/blender/scripts/validate_voice_vac.test.py`
- Create: `scripts/release/verify-blender-assets.sh`
- Create: `docs/evidence/release-0.2.0/blender-asset-qa.json`
- Create: `docs/evidence/release-0.2.0/blender-asset-qa.md`
- Create: `docs/evidence/release-0.2.0/assets/blender-device-idle.png`
- Create: `docs/evidence/release-0.2.0/assets/blender-hose-c-curve.png`
- Create: `docs/evidence/release-0.2.0/assets/blender-hose-diagonal.png`
- Create: `docs/evidence/release-0.2.0/assets/blender-nozzle-front.png`
- Create: `docs/evidence/release-0.2.0/assets/blender-button-pressed.png`
- Create: `docs/evidence/release-0.2.0/assets/blender-outliner-rig.png`

**Interfaces:**
- Consumes `tools/blender/assets/voice-vac-machine.blend`, `VoiceVACDevice.usdz`, `VoiceVACHose.usdz`, and `asset-contract.json` created by Plan A.
- Produces a JSON result with `objects`, `materials`, `actions`, `armature`, `jointNames`, `jointParents`, `skin`, `bounds`, `meshStatistics`, and `renders`.
- The App asset contract test consumes the same ordered joint list; Blender and Swift may not maintain separate lists.

- [ ] **Step 1: Replace the old object-only validator test with a real armature test**

The fixture test must assert this exact contract:

```python
REQUIRED_OBJECTS = {
    "VAC_DEVICE_ROOT", "VAC_PORT", "VAC_NOZZLE", "VAC_NOZZLE_TIP",
    "VAC_BUTTON_BASE", "VAC_BUTTON_CAP", "VAC_HOSE_ARMATURE", "VAC_HOSE_SKIN"
}
REQUIRED_BONES = [f"VAC_HOSE_JOINT_{index:02d}" for index in range(64)]
REQUIRED_ACTIONS = {
    "VAC_IDLE", "VAC_NOZZLE_UNDOCK", "VAC_NOZZLE_ROTATE",
    "VAC_NOZZLE_ATTACH", "VAC_NOZZLE_SUCTION", "VAC_BUTTON_PRESS",
    "VAC_BUTTON_PAUSE", "VAC_RETRACT"
}
```

The test creates a temporary `.blend` with 63 bones and verifies failure includes `expected 64 ordered hose bones`; it then adds bone 63 and verifies success.

- [ ] **Step 2: Run the validator test and verify RED**

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/blender/scripts/validate_voice_vac.test.py
```

Expected: FAIL because the current validator checks object names/actions but not a 64-bone armature, parent chain, skin weights, or PBR materials.

- [ ] **Step 3: Implement structural validation**

`validate_voice_vac.py` must fail unless all conditions hold:

- exactly one armature named `VAC_HOSE_ARMATURE`;
- exactly 64 deform bones named `VAC_HOSE_JOINT_00` through `VAC_HOSE_JOINT_63`;
- joint 00 has no hose-joint parent and each later joint's parent is the immediately preceding joint;
- `VAC_HOSE_SKIN` has an Armature modifier targeting `VAC_HOSE_ARMATURE` and a vertex group for every joint;
- at least 95% of hose vertices have nonzero normalized deform weight and no vertex has more than four deform influences;
- nozzle tip, button cap, and hose skin have nonzero bounds and finite transforms;
- every required mesh uses a Principled BSDF material with nonempty base color, roughness, and metallic values;
- corrugated hose bounds contain at least 48 visible ridge periods in the undeformed asset;
- all required actions have keyframes and the button cap has nonzero travel in `VAC_BUTTON_PRESS`;
- `asset-contract.json` lists the same 64 ordered joints and SHA-256 values for both USDZ files.

- [ ] **Step 4: Extend the preview renderer with named release shots**

Support:

```bash
--shot idle|hose-c|hose-diagonal|nozzle-front|button-pressed
--output /absolute/output.png
```

Each shot uses a fixed camera, neutral warm-gray studio lighting, transparent background, 1600×1000 pixels, Filmic/AgX color management, and the exact action/frame defined in `asset-contract.json`. No view may hide corrugation intersections or hard folds.

- [ ] **Step 5: Run automatic validation and render all five shots**

```bash
bash scripts/release/verify-blender-assets.sh \
  --json docs/evidence/release-0.2.0/blender-asset-qa.json \
  --render-dir docs/evidence/release-0.2.0/assets
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath native/macos/.derived/VoiceVAC \
  -only-testing:VoiceVACAppTests/RealityAssetContractTests test
```

Expected: Blender exits 0, JSON says `jointCount: 64`, all required nodes/actions pass, all five PNGs are 1600×1000, and the Swift asset test passes.

- [ ] **Step 6: Perform Blender visual inspection with Computer Use**

Open `tools/blender/assets/voice-vac-machine.blend` in Blender, keep Blender visible beside Codex, and record:

1. Outliner expanded to `VAC_HOSE_ARMATURE`, showing the first and last joint names; capture `blender-outliner-rig.png`.
2. Pose Mode C curve: confirm a smooth corrugated arc, no rigid straight cylinder, no angular zigzag, no inside-wall explosion, and no detached nozzle.
3. Full diagonal extension: confirm active visible geometry can cover the single-display diagonal without visually stretching the ridge pitch beyond the approved range.
4. Nozzle front/side: confirm a rectangular duckbill mouth, rotary collar, and game-prop depth.
5. Button press: confirm red cap, dark base, short vertical travel, contact shadow, and no flat UI icon.

Record each verdict and image SHA-256 in `blender-asset-qa.md`. Any failed visual item returns the task to Plan A Task 5; do not waive it in prose.

- [ ] **Step 7: Commit the completed asset gate and evidence**

```bash
git diff --check
git add tools/blender/scripts/validate_voice_vac.py tools/blender/scripts/render_voice_vac_preview.py tools/blender/scripts/validate_voice_vac.test.py scripts/release/verify-blender-assets.sh docs/evidence/release-0.2.0/blender-asset-qa.json docs/evidence/release-0.2.0/blender-asset-qa.md docs/evidence/release-0.2.0/assets/blender-*.png
git commit -m "test: verify Voice VAC Blender release assets"
```

---

### Task 3: Validate the native capsule, panels, hose physics, and interaction states

**Files:**
- Create: `scripts/release/verify-native-overlay.sh`
- Create: `native/macos/App/VoiceVACUITests/VoiceVACReleaseVisualTests.swift`
- Create: `docs/evidence/release-0.2.0/native-overlay-qa.md`
- Create: `docs/evidence/release-0.2.0/assets/app-idle.png`
- Create: `docs/evidence/release-0.2.0/assets/app-url-input.png`
- Create: `docs/evidence/release-0.2.0/assets/app-warning-yellow.png`
- Create: `docs/evidence/release-0.2.0/assets/app-button-pressed.png`
- Create: `docs/evidence/release-0.2.0/assets/app-transcribing.png`
- Create: `docs/evidence/release-0.2.0/assets/app-retraction.mov`
- Modify: `native/macos/App/VoiceVAC/Views/CapsuleGlassView.swift`
- Modify: `native/macos/App/VoiceVAC/Reality/DeviceRealityView.swift`
- Modify: `native/macos/App/VoiceVAC/Panels/TranscriptPanel.swift`
- Modify: `native/macos/App/VoiceVAC/Panels/URLInputPanel.swift`
- Modify: `native/macos/App/VoiceVAC/Interaction/NozzleRetractionController.swift`

**Interfaces:**
- Consumes the native App and test hooks created by Plan A.
- Produces automated UI assertions plus a manual evidence table for the exact visual states `idle`, `urlInput`, `warningYellow`, `ready`, `transcribing`, `paused`, and `retracting`.

- [ ] **Step 1: Write failing release UI tests**

```swift
func testReleaseCapsuleContract() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--release-ui-test", "--state", "idle"]
    app.launch()

    let capsule = app.otherElements["voice-vac-capsule"]
    XCTAssertTrue(capsule.waitForExistence(timeout: 5))
    XCTAssertEqual(capsule.frame.width, 406, accuracy: 2)
    XCTAssertEqual(capsule.frame.height, 116, accuracy: 2)
    XCTAssertTrue(app.otherElements["voice-vac-nozzle"].exists)
    XCTAssertTrue(app.otherElements["voice-vac-red-button"].exists)
    XCTAssertFalse(app.windows["Voice VAC Main Window"].exists)
}

func testInvalidDropHoldsUntilExplicitRetraction() throws {
    let app = XCUIApplication()
    app.launchArguments = ["--release-ui-test", "--state", "warningYellow"]
    app.launch()
    XCTAssertTrue(app.otherElements["voice-vac-warning-yellow"].waitForExistence(timeout: 5))
    sleep(5)
    XCTAssertTrue(app.otherElements["voice-vac-nozzle-deployed"].exists)
}
```

Also assert `LSUIElement=true`, no Dock activation, the transcript bubble is a separate window, URL input becomes key only while visible, and the hose overlay is click-through outside the nozzle panel.

- [ ] **Step 2: Run the focused UI suite and verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC \
  -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath native/macos/.derived/VoiceVAC \
  -only-testing:VoiceVACUITests/VoiceVACReleaseVisualTests test
```

Expected: at least one release accessibility identifier or state launch hook is absent.

- [ ] **Step 3: Add only the missing deterministic test hooks in Plan A files**

Expose release-only launch arguments under a compile-time `VOICE_VAC_UI_TESTING` condition. Do not add hidden production state shortcuts. Accessibility identifiers must be assigned to the existing capsule, nozzle, red button, transcript bubble, URL input, warning indicator, and retraction control.

- [ ] **Step 4: Run the full native automatic gate**

```bash
bash scripts/release/verify-native-overlay.sh
```

The script must run:

```bash
swift test --package-path native/macos
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC \
  -configuration Release -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath native/macos/.derived/VoiceVAC test
codesign --force --deep --sign - --timestamp=none \
  'native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app'
plutil -extract LSUIElement raw -o - \
  'native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app/Contents/Info.plist'
codesign --verify --deep --strict \
  'native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app'
```

Expected: Swift and Xcode tests pass, `LSUIElement` prints `true`, and `codesign` exits 0 after ad-hoc signing.

- [ ] **Step 5: Capture the native visual states with Computer Use**

Launch the Release App over a high-contrast moving Chrome window and capture the named files. Verify manually:

- capsule is approximately the male desktop pet's height and exactly 3.5:1 in layout contract;
- base is smooth clear Liquid Glass, not an opaque/matte white card;
- only nozzle and red button occupy the capsule;
- empty overlay pixels are transparent and do not intercept Chrome clicks;
- URL path follows the locked lift → rotate → C extension → reverse-C/S curl sequence;
- warning remains deployed for at least five seconds;
- pressed/transcribing and partial-rise/paused button depths are visibly distinct;
- retraction monotonically consumes active length, then rotates the nozzle vertical and docks it.

The `.mov` must show the complete retraction without edits. Record display scale, App commit, duration, and file hashes in `native-overlay-qa.md`.

- [ ] **Step 6: Commit native validation hooks and evidence**

```bash
git diff --check
git add scripts/release/verify-native-overlay.sh native/macos/App/VoiceVACUITests/VoiceVACReleaseVisualTests.swift native/macos/App/VoiceVAC/Views/CapsuleGlassView.swift native/macos/App/VoiceVAC/Reality/DeviceRealityView.swift native/macos/App/VoiceVAC/Panels/TranscriptPanel.swift native/macos/App/VoiceVAC/Panels/URLInputPanel.swift native/macos/App/VoiceVAC/Interaction/NozzleRetractionController.swift docs/evidence/release-0.2.0/native-overlay-qa.md docs/evidence/release-0.2.0/assets/app-*.png docs/evidence/release-0.2.0/assets/app-retraction.mov
git commit -m "test: validate Voice VAC native overlay states"
```

---

### Task 4: Build and byte-scan the separate Store and Automation extensions

**Files:**
- Modify: `apps/chrome-extension/package.json`
- Modify: `apps/chrome-extension/scripts/build-extension.mjs`
- Modify: `apps/chrome-extension/scripts/package-extension.mjs`
- Create: `scripts/release/scan-extension-bundle.mjs`
- Create: `scripts/release/scan-extension-bundle.test.mjs`
- Create: `docs/evidence/release-0.2.0/store-extension-scan.json`
- Create: `docs/evidence/release-0.2.0/automation-extension-scan.json`
- Create: `docs/evidence/release-0.2.0/store-extension-scan.md`
- Create: `docs/evidence/release-0.2.0/automation-extension-scan.md`
- Create: `docs/evidence/release-0.2.0/assets/store-extension-card.png`
- Create: `docs/evidence/release-0.2.0/assets/automation-extension-card.png`

**Interfaces:**
- Consumes `apps/chrome-extension/dist/store/`, `apps/chrome-extension/dist/automation/`, and the dual-build manifests created by Plan B.
- Produces the two final Extension ZIPs under `dist/release/` and independent JSON scan reports.

- [ ] **Step 1: Write failing archive-scan tests with malicious fixtures**

Create temporary ZIPs in the test and prove the scanner rejects:

- Store manifest containing `debugger`;
- Store JavaScript containing `chrome.debugger`, `Input.dispatchMouseEvent`, `Runtime.evaluate`, or `Page.navigate`;
- ZIP entry beginning with `/` or containing `../`;
- symlink entries;
- remotely hosted executable JavaScript;
- `eval(` or `new Function(` in production code;
- Automation ZIP without `debugger` or without its named CDP driver;
- equal Store and Automation Extension IDs.

```js
test('Store scanner rejects debugger bytes even when manifest is clean', async () => {
  const archive = await makeFixtureZip({
    manifest: storeManifest,
    files: { 'service-worker.js': 'chrome["debugger"].attach({tabId: 1});' }
  });
  await assert.rejects(() => scanExtensionBundle({ kind: 'store', archive }), /forbidden Store byte/i);
});
```

- [ ] **Step 2: Run the scanner tests and verify RED**

```bash
node --test scripts/release/scan-extension-bundle.test.mjs
```

Expected: FAIL because the scanner does not exist.

- [ ] **Step 3: Implement manifest, identity, file, and byte inspection**

For each archive, write:

```js
{
  schemaVersion: 1,
  kind: 'store',
  archive: { fileName: '...', sha256: '...', sizeBytes: 0 },
  manifest: { version: '0.2.0', permissions: [], hostPermissions: [], extensionID: '...' },
  files: [{ path: 'service-worker.js', sha256: '...', sizeBytes: 0 }],
  forbiddenMatches: [],
  requiredMatches: [],
  verdict: 'pass'
}
```

Compute Extension ID from the manifest public key rather than trusting a copied label. Sort all paths and JSON keys deterministically.

- [ ] **Step 4: Build and package both variants**

Add exact workspace scripts:

```json
{
  "build:store": "node scripts/build-extension.mjs --variant store",
  "build:automation": "node scripts/build-extension.mjs --variant automation",
  "package:store": "npm run build:store && node scripts/package-extension.mjs --variant store --output ../../dist/release/Voice-VAC-Store-Extension-0.2.0.zip",
  "package:automation": "npm run build:automation && node scripts/package-extension.mjs --variant automation --output ../../dist/release/Voice-VAC-Automation-Extension-0.2.0.zip"
}
```

Run:

```bash
rm -rf apps/chrome-extension/dist/store apps/chrome-extension/dist/automation
npm run package:store --workspace=@voivox/chrome-extension
npm run package:automation --workspace=@voivox/chrome-extension
```

- [ ] **Step 5: Scan the exact ZIP bytes and save reports**

```bash
node scripts/release/scan-extension-bundle.mjs \
  --kind store \
  --archive dist/release/Voice-VAC-Store-Extension-0.2.0.zip \
  --json-output docs/evidence/release-0.2.0/store-extension-scan.json
node scripts/release/scan-extension-bundle.mjs \
  --kind automation \
  --archive dist/release/Voice-VAC-Automation-Extension-0.2.0.zip \
  --json-output docs/evidence/release-0.2.0/automation-extension-scan.json
```

Expected: both verdicts are `pass`; Store has zero forbidden matches; Automation records `debugger` and the expected CDP driver as required matches.

- [ ] **Step 6: Manually load both unpacked builds in separate clean Chrome profiles**

Use Computer Use to open `chrome://extensions` in two isolated profiles. Capture the Extension card, ID, version, and permission-warning detail for each. Confirm the Store card never requests debugging access and the Automation card clearly explains it. Record screenshots and their hashes in the two Markdown reports.

- [ ] **Step 7: Commit the dual-package release gate**

```bash
git diff --check
git add apps/chrome-extension/package.json apps/chrome-extension/scripts/build-extension.mjs apps/chrome-extension/scripts/package-extension.mjs scripts/release/scan-extension-bundle.mjs scripts/release/scan-extension-bundle.test.mjs docs/evidence/release-0.2.0/store-extension-scan.json docs/evidence/release-0.2.0/automation-extension-scan.json docs/evidence/release-0.2.0/store-extension-scan.md docs/evidence/release-0.2.0/automation-extension-scan.md docs/evidence/release-0.2.0/assets/store-extension-card.png docs/evidence/release-0.2.0/assets/automation-extension-card.png
git commit -m "test: scan Voice VAC extension release variants"
```

---

### Task 5: Build deterministic spoken-video fixtures and execute the full Store path with Computer Use

**Files:**
- Create: `tests/fixtures/voice-vac-video/index.html`
- Create: `tests/fixtures/voice-vac-video/distractor.html`
- Create: `scripts/e2e/make-spoken-video-fixtures.sh`
- Create: `scripts/e2e/serve-video-fixtures.mjs`
- Create: `scripts/e2e/serve-video-fixtures.test.mjs`
- Create: `docs/evidence/release-0.2.0/real-chrome-video-e2e.md`
- Create: `docs/evidence/release-0.2.0/assets/store-arm-tab.png`
- Create: `docs/evidence/release-0.2.0/assets/store-ready.png`
- Create: `docs/evidence/release-0.2.0/assets/store-transcribing.png`
- Create: `docs/evidence/release-0.2.0/assets/store-completed.png`
- Create: `docs/evidence/release-0.2.0/assets/store-warning-hold.png`
- Create: `docs/evidence/release-0.2.0/assets/store-real-video-e2e.mov`
- Create: `docs/evidence/release-0.2.0/assets/xhs-mv-completed.png`

**Interfaces:**
- Serves target page at `http://127.0.0.1:4178/` and distractor page at `http://127.0.0.1:4178/distractor.html`.
- Target audio contains sentinel `VOICE VAC TARGET ALPHA`; distractor contains `ORANGE SATELLITE DISTRACTOR`. The target transcript must contain the former and must not contain the latter.

- [ ] **Step 1: Write the failing fixture-server test**

```js
test('fixture server exposes target and distractor with byte ranges', async () => {
  const server = await startFixtureServer({ root, port: 0 });
  const target = await fetch(`${server.url}/`);
  assert.equal(target.status, 200);
  assert.match(await target.text(), /target\.mp4/);
  const ranged = await fetch(`${server.url}/media/target.mp4`, {
    headers: { Range: 'bytes=0-31' }
  });
  assert.equal(ranged.status, 206);
  await server.close();
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/e2e/serve-video-fixtures.test.mjs
```

Expected: FAIL because the fixture server does not exist.

- [ ] **Step 3: Implement deterministic bilingual media generation**

The shell script must:

1. require `/usr/bin/say` and `ffmpeg`;
2. synthesize target English and Chinese lines into separate AIFF files;
3. synthesize distractor lines into a different AIFF;
4. concatenate each track with one second of leading/trailing silence;
5. mux each into a 1280×720 H.264/AAC MP4 with a clearly labeled static frame;
6. write SHA-256 values and exact spoken scripts to `/tmp/voice-vac-e2e-media/fixture-manifest.json`.

Exact scripts:

```text
Voice VAC target channel alpha. The private tunnel should capture only this sentence.
Voice VAC 目标通道甲。私有音频通道只应该记录这一句话。

Orange satellite distractor. This other tab must never appear in the target transcript.
橙色卫星干扰通道。这个其他标签页绝对不能出现在目标转录中。
```

- [ ] **Step 4: Generate and serve the fixtures**

```bash
bash scripts/e2e/make-spoken-video-fixtures.sh
node scripts/e2e/serve-video-fixtures.mjs \
  --media-root /tmp/voice-vac-e2e-media \
  --host 127.0.0.1 --port 4178
```

Expected: server prints `VOICE_VAC_FIXTURE_READY http://127.0.0.1:4178/` and stays running.

- [ ] **Step 5: Run the complete Store interaction through Computer Use**

In the clean Store Chrome profile and the Release App:

1. Open target page and click the Store Extension once to arm it.
2. Confirm arming does not play, mute, capture, or transcribe.
3. Drag the 3D nozzle from the capsule to the visible target video play region.
4. Confirm the Chrome video shows an absorption outline and release into `ready`.
5. Confirm no transcript appears before the red button is pressed.
6. Press the physical red button; confirm the button depresses, only the target video starts, and incremental source-language text appears.
7. Press again to pause; verify media and transcript growth pause. Press again to resume.
8. Switch to the distractor tab for five seconds; confirm capture remains bound to the original target tab.
9. Return to the target, complete capture, expand the bubble, copy the full text, and verify copied content excludes UI labels.
10. Click `×`; confirm stop/flush happens before controlled retraction.
11. Drag to a non-video area; capture `warningYellow`, wait five seconds, then re-drag successfully and finally retract with `×`.
12. Double-click the nozzle and enter the target fixture URL; verify the locked four-stage URL animation and Start action.

Record one uninterrupted `.mov`, the five named screenshots, target `tabId/documentId`, session ID, source URL/title, copied transcript, and observable timestamps in `real-chrome-video-e2e.md`.

- [ ] **Step 6: Repeat the final completed path on the owned Xiaohongshu MV**

Open the exact rights-cleared URL in the user's signed-in normal Chrome profile, arm it, attach, press the red button, capture at least 20 seconds, stop, and save `xhs-mv-completed.png`. Record platform limitations separately; do not reuse the deterministic fixture transcript as platform evidence.

- [ ] **Step 7: Commit fixtures and curated real-browser evidence**

```bash
git diff --check
git add tests/fixtures/voice-vac-video scripts/e2e/make-spoken-video-fixtures.sh scripts/e2e/serve-video-fixtures.mjs scripts/e2e/serve-video-fixtures.test.mjs docs/evidence/release-0.2.0/real-chrome-video-e2e.md docs/evidence/release-0.2.0/assets/store-*.png docs/evidence/release-0.2.0/assets/store-real-video-e2e.mov docs/evidence/release-0.2.0/assets/xhs-mv-completed.png
git commit -m "test: record Voice VAC real Chrome workflow"
```

---

### Task 6: Prove cross-window, multi-display, Retina, Spaces, and click-through behavior

**Files:**
- Create: `scripts/release/capture-display-layout.swift`
- Create: `scripts/release/capture-display-layout.test.sh`
- Create: `docs/evidence/release-0.2.0/multidisplay-qa.md`
- Create: `docs/evidence/release-0.2.0/assets/display-layout-single.json`
- Create: `docs/evidence/release-0.2.0/assets/display-layout-multiple.json`
- Create: `docs/evidence/release-0.2.0/assets/cross-window-diagonal.png`
- Create: `docs/evidence/release-0.2.0/assets/cross-display-boundary.png`
- Create: `docs/evidence/release-0.2.0/assets/multidisplay-recovery.mov`
- Create: `docs/evidence/release-0.2.0/assets/overlay-click-through.mov`

**Interfaces:**
- Produces normalized AppKit screen snapshots with `localizedName`, `frame`, `visibleFrame`, `backingScaleFactor`, and `isMain`.
- The evidence correlates those snapshots with `OverlayLayoutEngine` logs and visual recordings.

- [ ] **Step 1: Write a shell test for stable display JSON**

The test injects a JSON fixture into the formatter and verifies negative X origins, mixed scale factors, and stable screen ordering. It must fail if pixel dimensions are substituted for AppKit points.

- [ ] **Step 2: Verify RED**

```bash
bash scripts/release/capture-display-layout.test.sh
```

Expected: FAIL because `capture-display-layout.swift` is absent.

- [ ] **Step 3: Implement and run display capture**

```swift
import AppKit
import Foundation

let screens = NSScreen.screens.map { screen in
    [
        "localizedName": screen.localizedName,
        "frame": NSStringFromRect(screen.frame),
        "visibleFrame": NSStringFromRect(screen.visibleFrame),
        "backingScaleFactor": screen.backingScaleFactor,
        "isMain": screen == NSScreen.main
    ] as [String: Any]
}
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: screens, options: [.prettyPrinted, .sortedKeys]))
```

```bash
swift scripts/release/capture-display-layout.swift > docs/evidence/release-0.2.0/assets/display-layout-single.json
```

- [ ] **Step 4: Perform single-display cross-window tests with Computer Use**

Verify and record:

- nozzle reaches all four corners and the full diagonal with at least 8% active-length reserve;
- hose is not clipped by capsule bounds or Chrome window bounds;
- Chrome remains clickable through every transparent overlay pixel except the nozzle hit panel;
- moving and resizing Chrome preserves the attached target or returns a stable `TARGET_NAVIGATED`/re-arm message;
- Mission Control, another Space, and a full-screen Chrome Space preserve expected `canJoinAllSpaces`/`fullScreenAuxiliary` behavior;
- the capsule remains draggable only from empty glass and restores its saved position after relaunch.

- [ ] **Step 5: Perform mixed-scale multi-display tests with Computer Use**

Connect a second display and arrange it left of the main display so one screen has a negative X origin. Save `display-layout-multiple.json`, then verify:

1. drag the nozzle across the boundary in both directions with no jump, duplicate hose, or scale discontinuity;
2. attach to Chrome on the secondary display and transcribe;
3. move Chrome between displays while attached;
4. disconnect the secondary display while deployed;
5. confirm the nozzle/capsule are clamped onto the remaining visible frame and the session either remains valid or returns one explicit recoverable error;
6. reconnect and verify one overlay panel per display, never a giant union window.

Record both `.mov` files and a table of observed coordinates, scales, state transitions, and hashes in `multidisplay-qa.md`.

- [ ] **Step 6: Commit multi-display diagnostics and evidence**

```bash
git diff --check
git add scripts/release/capture-display-layout.swift scripts/release/capture-display-layout.test.sh docs/evidence/release-0.2.0/multidisplay-qa.md docs/evidence/release-0.2.0/assets/display-layout-*.json docs/evidence/release-0.2.0/assets/cross-*.png docs/evidence/release-0.2.0/assets/multidisplay-recovery.mov docs/evidence/release-0.2.0/assets/overlay-click-through.mov
git commit -m "test: verify Voice VAC cross-display overlays"
```

---

### Task 7: Verify permissions and target-tab audio isolation against other tabs, Spotify, Logic Pro, and microphone input

**Files:**
- Create: `scripts/release/capture-audio-devices.swift`
- Create: `scripts/release/compare-audio-snapshots.mjs`
- Create: `scripts/release/compare-audio-snapshots.test.mjs`
- Create: `scripts/release/scan-audio-boundaries.mjs`
- Create: `scripts/release/scan-audio-boundaries.test.mjs`
- Create: `docs/evidence/release-0.2.0/audio-isolation.json`
- Create: `docs/evidence/release-0.2.0/audio-isolation.md`
- Create: `docs/evidence/release-0.2.0/assets/audio-devices-before.json`
- Create: `docs/evidence/release-0.2.0/assets/audio-devices-after.json`
- Create: `docs/evidence/release-0.2.0/assets/isolation-transcript.txt`
- Create: `docs/evidence/release-0.2.0/assets/privacy-permissions.png`
- Create: `docs/evidence/release-0.2.0/assets/audio-isolation.mov`

**Interfaces:**
- `capture-audio-devices.swift` returns default input, output, and system-output device IDs, UIDs, names, and transport types.
- `compare-audio-snapshots.mjs` fails if any default device UID changes.
- `scan-audio-boundaries.mjs` proves the App/Extension contains no microphone or whole-system-capture entry point in the Store path.

- [ ] **Step 1: Write failing snapshot and static-boundary tests**

```js
test('default device changes fail the isolation gate', () => {
  assert.throws(() => compareAudioSnapshots(
    { defaultInputUID: 'mic-a', defaultOutputUID: 'out-a', defaultSystemOutputUID: 'out-a' },
    { defaultInputUID: 'mic-a', defaultOutputUID: 'out-b', defaultSystemOutputUID: 'out-a' }
  ), /default output device changed/);
});

test('Store boundary rejects microphone entry points', async () => {
  await assert.rejects(
    () => scanAudioBoundaries({ files: { 'worker.js': 'navigator.mediaDevices.getUserMedia({audio:true})' } }),
    /microphone capture/i
  );
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/release/compare-audio-snapshots.test.mjs scripts/release/scan-audio-boundaries.test.mjs
```

Expected: FAIL because both diagnostics are absent.

- [ ] **Step 3: Implement Core Audio snapshot capture**

Use `AudioObjectGetPropertyData` for:

- `kAudioHardwarePropertyDefaultInputDevice`;
- `kAudioHardwarePropertyDefaultOutputDevice`;
- `kAudioHardwarePropertyDefaultSystemOutputDevice`;
- each device's `kAudioDevicePropertyDeviceUID`, name, and transport type.

Output sorted JSON. Do not set any device property.

- [ ] **Step 4: Capture before-state and run static permission scans**

```bash
swift scripts/release/capture-audio-devices.swift > docs/evidence/release-0.2.0/assets/audio-devices-before.json
node scripts/release/scan-audio-boundaries.mjs \
  --app 'native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app' \
  --store-zip dist/release/Voice-VAC-Store-Extension-0.2.0.zip
```

The scan fails if the Store manifest requests microphone/desktop capture, the App contains `NSMicrophoneUsageDescription`, or Store production bytes call `getUserMedia`, `desktopCapture`, or process/system tap APIs. The separate experimental process-tap CLI may remain in source but must not be reachable from the Store target-tab workflow or presented as the verified D Channel.

- [ ] **Step 5: Run the real isolation matrix with Computer Use**

Set up simultaneously:

- target fixture tab playing `VOICE VAC TARGET ALPHA`;
- distractor fixture tab audibly looping `ORANGE SATELLITE DISTRACTOR`;
- Spotify audibly playing a track;
- Logic Pro audibly playing a project/loop;
- a normal microphone connected but not granted to Voice VAC.

Then arm only the target tab, attach, press the red button, and capture at least the complete target script. Verify:

- target tab alone becomes silent through the zero-gain capture graph;
- distractor tab, Spotify, and Logic Pro remain audible and keep their existing devices;
- transcript contains target sentinel and contains neither distractor sentinel nor recognizable Spotify/Logic content;
- macOS shows no Voice VAC microphone permission prompt or microphone-use indicator;
- default input/output/system-output UIDs are unchanged;
- switching focus among the other sources does not redirect capture.

Capture the uninterrupted `audio-isolation.mov` and Privacy & Security screenshot.

- [ ] **Step 6: Capture after-state, compare, and write evidence JSON**

```bash
swift scripts/release/capture-audio-devices.swift > docs/evidence/release-0.2.0/assets/audio-devices-after.json
node scripts/release/compare-audio-snapshots.mjs \
  --before docs/evidence/release-0.2.0/assets/audio-devices-before.json \
  --after docs/evidence/release-0.2.0/assets/audio-devices-after.json \
  --transcript docs/evidence/release-0.2.0/assets/isolation-transcript.txt \
  --required 'VOICE VAC TARGET ALPHA' \
  --forbidden 'ORANGE SATELLITE DISTRACTOR' \
  --json-output docs/evidence/release-0.2.0/audio-isolation.json
```

Expected: `devicesUnchanged: true`, `requiredPhrasePresent: true`, `forbiddenPhrasePresent: false`, `microphonePermissionRequested: false`, and verdict `pass`.

- [ ] **Step 7: Commit isolation diagnostics and evidence**

```bash
git diff --check
git add scripts/release/capture-audio-devices.swift scripts/release/compare-audio-snapshots.mjs scripts/release/compare-audio-snapshots.test.mjs scripts/release/scan-audio-boundaries.mjs scripts/release/scan-audio-boundaries.test.mjs docs/evidence/release-0.2.0/audio-isolation.json docs/evidence/release-0.2.0/audio-isolation.md docs/evidence/release-0.2.0/assets/audio-devices-*.json docs/evidence/release-0.2.0/assets/privacy-permissions.png docs/evidence/release-0.2.0/assets/audio-isolation.mov docs/evidence/release-0.2.0/assets/isolation-transcript.txt
git commit -m "test: prove Voice VAC target-tab audio isolation"
```

---

### Task 8: Run local Qwen ASR and packaged MCP end to end

**Files:**
- Create: `scripts/e2e/mcp-transcribe-active-video.mjs`
- Create: `scripts/e2e/mcp-transcribe-active-video.test.mjs`
- Create: `scripts/e2e/assert-asr-evidence.mjs`
- Create: `scripts/e2e/assert-asr-evidence.test.mjs`
- Create: `docs/evidence/release-0.2.0/asr-mcp-e2e.json`
- Create: `docs/evidence/release-0.2.0/asr-mcp-e2e.md`
- Create: `docs/evidence/release-0.2.0/assets/mcp-result.json`
- Create: `docs/evidence/release-0.2.0/assets/mcp-no-session-error.json`
- Create: `docs/evidence/release-0.2.0/assets/mcp-monitor-completed.png`

**Interfaces:**
- Uses packaged launcher `Voice VAC.app/Contents/Resources/voivox/voivox-mcp` and tool `transcribe_active_video`.
- Produces exact result fields `status`, `processing_mode`, `source_url`, `title`, `duration_seconds`, `language`, `transcript`, and ordered `segments`.

- [ ] **Step 1: Write failing MCP and ASR evidence tests**

```js
test('completed MCP result is structured and source-bound', () => {
  assert.equal(result.status, 'completed');
  assert.equal(result.source_url, 'http://127.0.0.1:4178/');
  assert.equal(result.title, 'Voice VAC Target Alpha');
  assert.match(result.transcript, /target channel alpha/i);
  assert(result.segments.every((segment, index, list) =>
    index === 0 || segment.start >= list[index - 1].start));
});

test('evidence rejects cloud speech and missing hardware data', () => {
  assert.throws(() => assertASREvidence({
    model: { id: 'Qwen/Qwen3-ASR-0.6B' },
    execution: { speechApiUsed: true }
  }), /local ASR evidence/);
});
```

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/e2e/mcp-transcribe-active-video.test.mjs scripts/e2e/assert-asr-evidence.test.mjs
```

Expected: FAIL because the E2E probes do not exist.

- [ ] **Step 3: Implement the packaged stdio MCP probe**

Use `@modelcontextprotocol/sdk` `Client` and `StdioClientTransport`. CLI options are:

```text
--launcher <absolute path>
--mode auto|live|accelerated
--language auto|zh|en
--timestamps true|false
--output <absolute JSON path>
--timeout-seconds 180
```

The probe calls:

```js
await client.callTool({
  name: 'transcribe_active_video',
  arguments: { mode: 'auto', language: 'auto', timestamps: false, output_format: 'text' }
});
```

Parse structured content, reject empty text, reject a source mismatch, and preserve stable MCP errors instead of converting them to empty success.

- [ ] **Step 4: Verify the no-session error first**

With the App open but no armed page:

```bash
release_app="$(pwd)/native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app"
launcher="$release_app/Contents/Resources/voivox/voivox-mcp"
node scripts/e2e/mcp-transcribe-active-video.mjs \
  --launcher "$launcher" \
  --mode auto --language auto --timestamps false \
  --output docs/evidence/release-0.2.0/assets/mcp-no-session-error.json \
  --timeout-seconds 30
```

Expected: nonzero tool result with stable code `NEEDS_USER_ARMING`, not an empty transcript and not a process crash.

- [ ] **Step 5: Run Live Tunnel ASR and MCP against the armed target fixture**

Using Computer Use, arm and attach the target fixture, then run:

```bash
release_app="$(pwd)/native/macos/.derived/VoiceVAC/Build/Products/Release/Voice VAC.app"
launcher="$release_app/Contents/Resources/voivox/voivox-mcp"
env -u OPENAI_API_KEY -u DASHSCOPE_API_KEY -u AZURE_OPENAI_API_KEY \
node scripts/e2e/mcp-transcribe-active-video.mjs \
  --launcher "$launcher" \
  --mode live --language auto --timestamps false \
  --output docs/evidence/release-0.2.0/assets/mcp-result.json \
  --timeout-seconds 180
```

Expected: source URL/title match the bound fixture; model is Qwen3-ASR-0.6B; Chinese and English remain in their source languages; first usable text arrives before refined completion; no API key is present.

- [ ] **Step 6: Verify accelerated mode and automatic fallback**

Run the URL path on the locally accessible fixture and record `processing_mode: accelerated_batch`; record acquisition, decode, inference, merge, total seconds, audio duration, and RTF. Then request accelerated mode on the Xiaohongshu page; inaccessible media bytes must fall back to `live_tunnel` without a second user start and must expose the fallback reason.

The evidence JSON must include:

```js
{
  hardware: { cpu: '...', gpu: '...', memoryBytes: 0 },
  model: { id: 'Qwen/Qwen3-ASR-0.6B', revision: 'exact revision', precision: '...' },
  audio: { durationSeconds: 0, channels: 1, sampleRateHz: 16000 },
  execution: {
    speechApiUsed: false, downloadIncluded: false, alignmentIncluded: false,
    acquisitionSeconds: 0, decodeSeconds: 0, inferenceSeconds: 0,
    mergeSeconds: 0, totalSeconds: 0, rtf: 0
  },
  mcp: { tool: 'transcribe_active_video', structuredResult: true },
  verdict: 'pass'
}
```

- [ ] **Step 7: Validate, capture MCP Monitor, and commit**

```bash
node scripts/e2e/assert-asr-evidence.mjs \
  --input docs/evidence/release-0.2.0/asr-mcp-e2e.json
npx vitest run apps/mcp/tests apps/desktop/tests/mcp-connection.test.ts packages/core/tests
git diff --check
git add scripts/e2e/mcp-transcribe-active-video.mjs scripts/e2e/mcp-transcribe-active-video.test.mjs scripts/e2e/assert-asr-evidence.mjs scripts/e2e/assert-asr-evidence.test.mjs docs/evidence/release-0.2.0/asr-mcp-e2e.json docs/evidence/release-0.2.0/asr-mcp-e2e.md docs/evidence/release-0.2.0/assets/mcp-*.json docs/evidence/release-0.2.0/assets/mcp-monitor-completed.png
git commit -m "test: prove Voice VAC ASR and MCP end to end"
```

---

### Task 9: Replace stale public visuals and document only verified behavior

**Files:**
- Modify: `README.md`
- Modify: `PRIVACY.md`
- Modify: `SECURITY.md`
- Modify: `THIRD_PARTY_NOTICES.md`
- Modify: `docs/assets/voice-vac-architecture.svg`
- Create: `docs/assets/voice-vac-architecture.png`
- Create: `docs/assets/voice-vac-app-idle.png`
- Create: `docs/assets/voice-vac-app-transcribing.png`
- Create: `docs/assets/voice-vac-extension-store.png`
- Create: `docs/assets/voice-vac-mcp-result.png`
- Modify: `docs/hackathon/OPENAI_BUILD_WEEK.md`
- Modify: `docs/release/RELEASE.md`
- Create: `docs/release/v0.2.0.md`
- Create: `scripts/release/verify-public-docs.mjs`
- Create: `scripts/release/verify-public-docs.test.mjs`

**Interfaces:**
- Consumes only screenshots and facts whose release evidence verdict is `pass`.
- Produces readable architecture PNG/SVG, public install instructions for App + Store/Automation variants, MCP command, limitations, and hackathon demo material.

- [ ] **Step 1: Write failing public-doc tests**

The validator must assert:

- README title and all user-visible labels use `Voice VAC`;
- README links to the new App, Store, Automation, and MCP evidence;
- architecture SVG has nonempty `<title>` and `<desc>`, contains App/Extension/MCP, D Channel, Local ASR, Transcript Store, and fallback labels, and contains no `COMPLETE` label unsupported by evidence;
- all local image links exist and raster images are at least 1200 pixels wide except compact UI screenshots;
- README contains the exact three artifact names and the packaged MCP command;
- Store versus Automation permissions are described separately;
- no public page calls the ad-hoc candidate notarized;
- Qwen3-ASR-0.6B is the primary model and old Whisper mode tables are removed from the current-product section;
- accelerated 5–10 second performance is described only as a research target unless the evidence records it.

- [ ] **Step 2: Run docs tests and verify RED**

```bash
node --test scripts/release/verify-public-docs.test.mjs
```

Expected: FAIL because current README, architecture status labels, artifact names, model table, and screenshots describe the Electron/Whisper-era product.

- [ ] **Step 3: Rebuild the architecture diagram from the locked native architecture**

The diagram must show, left to right:

```text
Chrome video + armed Store/Automation Extension
    → tabCapture / accessible media bytes
    → Local Bridge
    → Live Tunnel or Accelerated Decode
    → Qwen3-ASR Provider
    → Transcript Store
    → App transcript bubble / MCP transcribe_active_video / Codex
```

Below it, show native rendering separately:

```text
LSUIElement host → CapsulePanel + per-screen HoseOverlayPanel + NozzleHitPanel + TranscriptPanel
```

Use high-contrast text at 1600×980, no tiny paragraph text, and status labels `VERIFIED`, `EXPERIMENTAL`, or `RESEARCH TARGET` derived from evidence. Export with headless Chrome:

```bash
'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
  --headless --disable-gpu --hide-scrollbars \
  --window-size=1600,980 \
  --screenshot=docs/assets/voice-vac-architecture.png \
  "file://$(pwd)/docs/assets/voice-vac-architecture.svg"
```

- [ ] **Step 4: Promote only the approved evidence screenshots**

Copy without recompressing:

```bash
cp docs/evidence/release-0.2.0/assets/app-idle.png docs/assets/voice-vac-app-idle.png
cp docs/evidence/release-0.2.0/assets/app-transcribing.png docs/assets/voice-vac-app-transcribing.png
cp docs/evidence/release-0.2.0/assets/store-completed.png docs/assets/voice-vac-extension-store.png
cp docs/evidence/release-0.2.0/assets/mcp-monitor-completed.png docs/assets/voice-vac-mcp-result.png
```

README must display at least the idle App, transcribing App, Store result, MCP result, and architecture overview, each with accurate alt text.

- [ ] **Step 5: Rewrite install, trust-boundary, and hackathon sections**

Document:

- DMG install and ad-hoc Gatekeeper note;
- Store ZIP as the default choice;
- Automation ZIP as an explicit developer/enterprise choice with `debugger` disclosure;
- first arm action, drag/ready/red-button sequence, pause/resume, `×`, URL input, and fallback;
- packaged MCP command using `/Applications/Voice VAC.app/Contents/Resources/voivox/voivox-mcp`;
- no API, no microphone, target-tab-only evidence;
- Qwen first-use model download and local inference;
- exact verified versus experimental limitations;
- under-three-minute hackathon storyboard using the owned MV and no unlicensed music.

- [ ] **Step 6: Validate docs and commit**

```bash
node scripts/release/verify-public-docs.mjs
git diff --check
git add README.md PRIVACY.md SECURITY.md THIRD_PARTY_NOTICES.md docs/assets/voice-vac-architecture.svg docs/assets/voice-vac-architecture.png docs/assets/voice-vac-app-idle.png docs/assets/voice-vac-app-transcribing.png docs/assets/voice-vac-extension-store.png docs/assets/voice-vac-mcp-result.png docs/hackathon/OPENAI_BUILD_WEEK.md docs/release/RELEASE.md docs/release/v0.2.0.md scripts/release/verify-public-docs.mjs scripts/release/verify-public-docs.test.mjs
git commit -m "docs: publish Voice VAC 0.2.0 verified experience"
```

---

### Task 10: Package the DMG and two ZIPs, generate checksums, and verify a clean install

**Files:**
- Create: `scripts/release/package-native-app.sh`
- Create: `scripts/release/generate-checksums.sh`
- Create: `scripts/release/verify-release-artifacts.mjs`
- Create: `scripts/release/verify-release-artifacts.test.mjs`
- Create: `docs/release/v0.2.0-checksums.md`
- Create: `docs/evidence/release-0.2.0/clean-install.md`
- Create: `docs/evidence/release-0.2.0/assets/codesign-verify.txt`
- Create: `docs/evidence/release-0.2.0/assets/gatekeeper-assessment.txt`
- Create: `docs/evidence/release-0.2.0/assets/dmg-install.png`
- Create: `docs/evidence/release-0.2.0/assets/clean-store-extension.png`
- Create: `docs/evidence/release-0.2.0/assets/clean-automation-extension.png`

**Interfaces:**
- Produces exactly three public artifacts and `SHA256SUMS.txt` in `dist/release/`.
- `verify-release-artifacts.mjs` consumes the release contract and writes no evidence unless all content checks pass.

- [ ] **Step 1: Write failing artifact-verifier tests**

Test rejection of:

- missing or extra public artifacts;
- wrong semantic version or architecture;
- DMG without `Voice VAC.app`;
- App with wrong bundle ID, `LSUIElement=false`, absent MCP launcher, absent Reality assets, or executable for non-arm64 architecture;
- ZIP with a parent directory instead of `manifest.json` at root;
- Store/Automation archive hashes differing from their scan reports;
- checksum file with unsorted names, duplicate lines, or uppercase hashes.

- [ ] **Step 2: Verify RED**

```bash
node --test scripts/release/verify-release-artifacts.test.mjs
```

Expected: FAIL because the verifier is absent.

- [ ] **Step 3: Implement deterministic native packaging**

`package-native-app.sh` must:

1. build Release with `scripts/build-native-app.sh`;
2. stage `Voice VAC.app`, Applications symlink, LICENSE, privacy summary, and install README;
3. sign nested executable helpers and MCP launcher, then the outer App, with ad-hoc identity `-`;
4. run `codesign --verify --deep --strict --verbose=2`;
5. create a read-only UDZO image with volume name `Voice VAC`;
6. write only `dist/release/Voice-VAC-0.2.0-arm64.dmg`.

Run:

```bash
rm -rf dist/release dist/staging
bash scripts/release/package-native-app.sh
npm run package:store --workspace=@voivox/chrome-extension
npm run package:automation --workspace=@voivox/chrome-extension
```

- [ ] **Step 4: Generate exact checksums and verify artifact bytes**

```bash
bash scripts/release/generate-checksums.sh dist/release > dist/release/SHA256SUMS.txt
node scripts/release/verify-release-artifacts.mjs \
  --release-dir dist/release \
  --store-scan docs/evidence/release-0.2.0/store-extension-scan.json \
  --automation-scan docs/evidence/release-0.2.0/automation-extension-scan.json
```

`SHA256SUMS.txt` contains exactly three sorted lowercase SHA-256 lines. Copy the same values into fenced text in `docs/release/v0.2.0-checksums.md`.

- [ ] **Step 5: Record signing and Gatekeeper truthfully**

```bash
mount_point="$(hdiutil attach dist/release/Voice-VAC-0.2.0-arm64.dmg -nobrowse -readonly | awk '/\/Volumes\// {print substr($0, index($0, "/Volumes/")); exit}')"
codesign --verify --deep --strict --verbose=2 \
  "$mount_point/Voice VAC.app" \
  > docs/evidence/release-0.2.0/assets/codesign-verify.txt 2>&1
spctl --assess --type execute --verbose=4 \
  "$mount_point/Voice VAC.app" \
  > docs/evidence/release-0.2.0/assets/gatekeeper-assessment.txt 2>&1 || true
hdiutil detach "$mount_point"
```

Expected: `codesign` passes; `spctl` reports rejection because the candidate is not notarized. `clean-install.md` and README must say this plainly.

- [ ] **Step 6: Clean-install from artifacts, never from build directories**

1. Mount the DMG and copy `Voice VAC.app` to `/Applications`.
2. Launch via right-click Open once if Gatekeeper requires it; capture `dmg-install.png`.
3. Unzip Store ZIP to `/tmp/voice-vac-store-0.2.0`, load it in a fresh Chrome profile, and perform target fixture arm → attach → red-button → transcript.
4. Unzip Automation ZIP to `/tmp/voice-vac-automation-0.2.0`, load it in a different fresh profile, accept the debug warning, and perform the Automation playback path.
5. Run packaged MCP and confirm `voivox_status` plus `transcribe_active_video` against the clean-installed App.
6. Re-run `codesign`, Extension byte scans, and checksums against the mounted/copied artifacts.

Record commands, observed permissions, screenshots, artifact hashes, and pass results in `clean-install.md`.

- [ ] **Step 7: Commit packaging code and curated evidence**

```bash
git diff --check
git add scripts/release/package-native-app.sh scripts/release/generate-checksums.sh scripts/release/verify-release-artifacts.mjs scripts/release/verify-release-artifacts.test.mjs docs/release/v0.2.0-checksums.md docs/evidence/release-0.2.0/clean-install.md docs/evidence/release-0.2.0/assets/codesign-verify.txt docs/evidence/release-0.2.0/assets/gatekeeper-assessment.txt docs/evidence/release-0.2.0/assets/dmg-install.png docs/evidence/release-0.2.0/assets/clean-store-extension.png docs/evidence/release-0.2.0/assets/clean-automation-extension.png
git commit -m "build: package Voice VAC 0.2.0 release candidate"
```

---

### Task 11: Wire CI, run the final clean-checkout gate, and create a draft GitHub release

**Files:**
- Modify: `.github/workflows/verify.yml`
- Modify: `.github/workflows/package-macos.yml`
- Create: `scripts/release/final-gate.sh`
- Create: `scripts/release/final-gate.test.sh`
- Modify: `docs/evidence/release-0.2.0/README.md`
- Modify: `docs/release/v0.2.0.md`

**Interfaces:**
- `final-gate.sh` is the sole command used locally and in packaging CI.
- CI uploads the same three artifacts and checksum file validated locally; it never publishes from an unverified build directory.

- [ ] **Step 1: Write the failing final-gate shell test**

The test stubs commands and verifies this strict order:

```text
preflight
npm ci
JavaScript/TypeScript tests
Swift package tests
Xcode native tests
Blender validation
Store build + scan
Automation build + scan
App package
artifact verification
checksum generation
docs verification
git diff check
clean-worktree check
```

It must fail if any command is skipped or if shell error propagation is disabled.

- [ ] **Step 2: Verify RED**

```bash
bash scripts/release/final-gate.test.sh
```

Expected: FAIL because `final-gate.sh` does not exist.

- [ ] **Step 3: Implement the final gate and CI workflows**

`final-gate.sh` starts with:

```bash
#!/usr/bin/env bash
set -euo pipefail
test "$(uname -m)" = arm64
node scripts/release/preflight.mjs \
  --expected-commit "$(git rev-parse HEAD)" \
  --json-output /tmp/voice-vac-release-0.2.0-environment.json
npm ci
npm test
npm run typecheck
npm run build
swift test --package-path native/macos
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC \
  -configuration Release -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath native/macos/.derived/VoiceVAC test
```

Then call the exact Blender, dual-extension, packaging, artifact, checksum, and docs gates from earlier tasks. End with `git diff --check` and a clean-worktree assertion that ignores only `dist/`.

`.github/workflows/package-macos.yml` must use Xcode 26, run `final-gate.sh`, upload exactly the three artifacts plus `SHA256SUMS.txt`, and compare workflow-generated SHA-256 values with `docs/release/v0.2.0-checksums.md`. It must not use the old Electron `package:mac` path or old single-Extension ZIP name.

- [ ] **Step 4: Commit CI before the final clean run**

```bash
git diff --check
git add .github/workflows/verify.yml .github/workflows/package-macos.yml scripts/release/final-gate.sh scripts/release/final-gate.test.sh docs/evidence/release-0.2.0/README.md docs/release/v0.2.0.md
git commit -m "ci: enforce Voice VAC 0.2.0 release gate"
```

- [ ] **Step 5: Run from a detached clean worktree at the exact release commit**

```bash
release_sha="$(git rev-parse HEAD)"
rm -rf /tmp/voice-vac-release-0.2.0
git worktree add --detach /tmp/voice-vac-release-0.2.0 "$release_sha"
cd /tmp/voice-vac-release-0.2.0
bash scripts/release/final-gate.sh
git status --short
```

Expected: final gate exits 0 and `git status --short` prints nothing. Copy the verified artifacts back to the primary checkout's ignored `dist/release/` only after hashes match.

- [ ] **Step 6: Self-review the plan and release evidence before tagging**

Run from the primary checkout:

```bash
rg -n 'TO[D]O|TB[D]|implement late[r]|fill in detail[s]|manual gate remain[s]' \
  docs/superpowers/plans/2026-07-19-voice-vac-release-validation.md \
  docs/evidence/release-0.2.0 README.md docs/release
node scripts/release/verify-public-docs.mjs
node scripts/release/verify-release-artifacts.mjs --release-dir dist/release \
  --store-scan docs/evidence/release-0.2.0/store-extension-scan.json \
  --automation-scan docs/evidence/release-0.2.0/automation-extension-scan.json
git diff --check
git status --short
```

Expected: the placeholder scan prints nothing, documentation and artifact verification pass, and the worktree is clean. Review the locked design sections one by one and map every release requirement to a passing evidence row in `docs/evidence/release-0.2.0/README.md`.

- [ ] **Step 7: Tag and create a draft GitHub release**

```bash
git tag -a v0.2.0 -m "Voice VAC 0.2.0"
git push origin codex/voice-vac-native
git push origin v0.2.0
gh release create v0.2.0 \
  dist/release/Voice-VAC-0.2.0-arm64.dmg \
  dist/release/Voice-VAC-Store-Extension-0.2.0.zip \
  dist/release/Voice-VAC-Automation-Extension-0.2.0.zip \
  dist/release/SHA256SUMS.txt \
  --draft \
  --title 'Voice VAC 0.2.0' \
  --notes-file docs/release/v0.2.0.md
```

Expected: GitHub returns a draft release URL. Download all four uploaded files into `/tmp/voice-vac-github-release-0.2.0/`, re-run SHA-256 verification, and include the matching result plus draft URL in the release handoff before asking the user to publish the draft. Do not modify the tagged commit after verification.

---

## Final Completion Gate

- [ ] Blender automatic validator and Swift Reality asset test both prove the exact 64-joint ordered rig, skin, nozzle, button, materials, bounds, animations, and asset hashes.
- [ ] Blender Computer Use evidence shows idle device, C curve, full diagonal, duckbill front, button press, and expanded armature Outliner without intersections or primitive fallback.
- [ ] Native tests and Computer Use evidence prove Liquid Glass capsule, no ordinary main window/Dock icon, transparent click-through overlays, URL animation, warning hold, physical button travel, transcript bubble, and controlled retraction.
- [ ] Store and Automation ZIP byte scans pass against the final archive hashes; Store contains no debugger/CDP bytes and Automation contains the disclosed driver.
- [ ] The uninterrupted Store recording proves arm → drag → ready → red-button start → incremental text → pause/resume → complete → `×` retraction.
- [ ] The owned Xiaohongshu MV has a separate completed-path screenshot and transcript evidence.
- [ ] Single-display diagonal, mixed-scale multi-display, negative coordinates, cross-boundary drag, display disconnect, Spaces/full-screen, and click-through gates have real recordings.
- [ ] Core Audio device UIDs are unchanged; distractor tab, Spotify, Logic Pro, and microphone are absent from the target transcript and untouched by device configuration.
- [ ] Local Qwen ASR evidence includes hardware, revision, precision, cache state, source language, timing breakdown, RTF, fallback, and `speechApiUsed: false`.
- [ ] Packaged MCP returns the bound transcript and stable no-session error through `transcribe_active_video`, with URL/title/mode/language/duration/segments.
- [ ] README, architecture PNG/SVG, screenshots, privacy/security notices, hackathon storyboard, release notes, and install instructions match only passing evidence.
- [ ] Clean-install evidence comes from the DMG and two final ZIPs, not source/build directories.
- [ ] `Voice-VAC-0.2.0-arm64.dmg`, Store ZIP, Automation ZIP, and `SHA256SUMS.txt` pass byte verification after GitHub upload.
- [ ] Draft GitHub release exists and remains unpublished until the user reviews the final App, evidence, and demo screenshots.
