# Voice VAC Native App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the real macOS 26 Voice VAC floating device with native Liquid Glass, independent transparent panels, a tested hose solver, and RealityKit assets.

**Architecture:** Keep existing macOS 14 CLI targets and add a Foundation/simd-only `VoiceVACCore` Swift package library. Use an XcodeGen-generated macOS 26 App target for AppKit, `NSGlassEffectView`, RealityKit resources, signing, and UI tests. Each screen owns one click-through hose overlay; the capsule, nozzle hit area, transcript, and URL input use separate panels.

**Tech Stack:** Swift 6.3, Swift Testing, AppKit, RealityKit, Metal fallback, XcodeGen, Xcode 26, Blender 5.2 LTS.

## Global Constraints

- User-visible brand is exactly `Voice VAC`.
- Visible App target is macOS 26, Apple Silicon, `LSUIElement=true`, bundle ID `io.voivox.app`.
- Existing `voivox-host` and `voivox-native-host` remain macOS 14 compatible.
- Capsule size is exactly `406 × 116 pt`; folded transcript bubble is `318 × 74 pt`.
- Invalid targets enter `warningYellow` without automatic retraction.
- No primitive/CSS/SVG production fallback for missing 3D assets.
- All App state transitions live in testable core code, not scattered panel event handlers.

---

### Task 1: Add the VoiceVACCore state and layout contracts

**Files:**
- Modify: `native/macos/Package.swift`
- Create: `native/macos/Sources/VoiceVACCore/State/VoiceVACState.swift`
- Create: `native/macos/Sources/VoiceVACCore/State/VoiceVACReducer.swift`
- Create: `native/macos/Sources/VoiceVACCore/Geometry/OverlayLayout.swift`
- Create: `native/macos/Sources/VoiceVACCore/Geometry/OverlayLayoutEngine.swift`
- Create: `native/macos/Sources/VoiceVACCore/Persistence/CapsulePlacementStore.swift`
- Create: `native/macos/Tests/VoiceVACCoreTests/VoiceVACReducerTests.swift`
- Create: `native/macos/Tests/VoiceVACCoreTests/OverlayLayoutEngineTests.swift`
- Create: `native/macos/Tests/VoiceVACCoreTests/CapsulePlacementStoreTests.swift`

**Interfaces:**
- Produces `VoiceVACState`, `VoiceVACAction`, `VoiceVACEffect`, `VoiceVACReducer.reduce`, `OverlayLayoutEngine`, and `CapsulePlacementStore` for all later App tasks.
- Uses Foundation, CoreGraphics, and simd only; no AppKit or RealityKit imports.

- [ ] **Step 1: Add the library/test targets and write failing reducer tests**

```swift
@Test("a rejected target stays deployed and never begins retraction")
func rejectedTargetStaysDeployed() {
    let deployed = VoiceVACState(
        phase: .dragging,
        nozzleGlobalPoint: CGPoint(x: 900, y: 500)
    )
    let failure = VoiceVACFailure(
        code: .noPlayableMedia,
        message: "No playable video found here."
    )

    let transition = VoiceVACReducer.reduce(
        state: deployed,
        action: .targetRejected(failure)
    )

    #expect(transition.state.phase == .warningYellow)
    #expect(transition.state.nozzleGlobalPoint == CGPoint(x: 900, y: 500))
    #expect(!transition.effects.contains(.beginRetraction))
}

@Test("ready requires a physical primary press before capture")
func readyGatesCapture() {
    let target = VideoTarget.fixture
    let ready = VoiceVACReducer.reduce(
        state: .idle,
        action: .targetResolved(target)
    ).state
    #expect(ready.phase == .ready)

    let started = VoiceVACReducer.reduce(
        state: ready,
        action: .primaryButtonPressed
    )
    #expect(started.state.phase == .transcribing)
    #expect(started.effects == [.startCapture(target)])
}
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
swift test --package-path native/macos --filter VoiceVACReducerTests
```

Expected: compilation fails because `VoiceVACCore` and its state types do not exist.

- [ ] **Step 3: Implement the exact state contract**

```swift
public enum VoiceVACPhase: String, Codable, Sendable {
    case idle, dragging, targetDetected, tabAudioOnly, ready
    case transcribing, paused, completed, retracting, warningYellow
}

public enum VoiceVACErrorCode: String, Codable, Sendable {
    case tabNotArmed = "TAB_NOT_ARMED"
    case noPlayableMedia = "NO_PLAYABLE_MEDIA"
    case targetNavigated = "TARGET_NAVIGATED"
    case captureDenied = "CAPTURE_DENIED"
    case streamIDExpired = "STREAM_ID_EXPIRED"
    case streamEnded = "STREAM_ENDED"
    case tabClosed = "TAB_CLOSED"
    case nativeHostUnavailable = "NATIVE_HOST_UNAVAILABLE"
    case noAudioAfterTimeout = "NO_AUDIO_AFTER_TIMEOUT"
}

public enum VoiceVACAction: Equatable, Sendable {
    case beginNozzleDrag(at: CGPoint)
    case moveNozzle(to: CGPoint)
    case targetResolved(VideoTarget)
    case targetRejected(VoiceVACFailure)
    case primaryButtonPressed
    case transcriptPreviewChanged(String)
    case captureCompleted
    case retractRequested
    case retractionCompleted
}
```

Reducer behavior must be exhaustive and return a `VoiceVACTransition(state:effects:)`. A primary press means start from `ready`, pause from `transcribing`, and resume from `paused`. Only `.retractRequested` may produce `.stopAndFlush` and `.beginRetraction`.

- [ ] **Step 4: Write layout tests before layout implementation**

```swift
@Test("default capsule is 24 points from the main screen bottom right")
func defaultPlacement() {
    let screen = ScreenDescriptor(
        id: ScreenID(rawValue: 1),
        frame: CGRect(x: 0, y: 0, width: 1710, height: 1107),
        visibleFrame: CGRect(x: 0, y: 80, width: 1710, height: 1003),
        backingScaleFactor: 2
    )
    let layout = OverlayLayoutEngine().makeLayout(
        screens: [screen],
        preferredScreenID: nil,
        savedPlacement: nil
    )

    #expect(layout.capsuleFrame.size == CGSize(width: 406, height: 116))
    #expect(layout.capsuleFrame.maxX == screen.visibleFrame.maxX - 24)
    #expect(layout.capsuleFrame.minY == screen.visibleFrame.minY + 24)
    #expect(layout.hoseFrames == [screen.id: screen.frame])
}
```

Also cover negative-coordinate monitors, disconnected saved screens, offscreen saved coordinates, and scale-factor independence.

- [ ] **Step 5: Implement layout and normalized persistence**

Use exact metrics:

```swift
public static let phaseOne = OverlayMetrics(
    capsuleSize: CGSize(width: 406, height: 116),
    edgeInset: 24,
    nozzleHitSize: CGSize(width: 96, height: 96),
    transcriptSize: CGSize(width: 318, height: 74),
    transcriptGap: 12
)
```

Persist under `voicevac.overlay.capsule-placement.v1` with a caller-supplied `UserDefaults` suite so tests never touch real settings.

- [ ] **Step 6: Run all Swift package tests and commit**

```bash
swift test --package-path native/macos
git add native/macos/Package.swift native/macos/Sources/VoiceVACCore native/macos/Tests/VoiceVACCoreTests
git commit -m "feat: add Voice VAC native state and layout core"
```

### Task 2: Create the native Xcode App bundle and process lifecycle

**Files:**
- Create: `native/macos/App/project.yml`
- Create: `native/macos/App/Config/Info.plist`
- Create: `native/macos/App/Config/Base.xcconfig`
- Create: `native/macos/App/Config/Debug.xcconfig`
- Create: `native/macos/App/Config/Release.xcconfig`
- Create: `native/macos/App/VoiceVAC/Application/VoiceVACMain.swift`
- Create: `native/macos/App/VoiceVAC/Application/AppDelegate.swift`
- Create: `native/macos/App/VoiceVAC/Application/AppEnvironment.swift`
- Create: `native/macos/App/VoiceVAC/State/VoiceVACStore.swift`
- Create: `native/macos/App/VoiceVAC/StatusItem/StatusItemController.swift`
- Create: `native/macos/App/VoiceVACAppTests/AppBundleContractTests.swift`
- Create: `scripts/build-native-app.sh`

**Interfaces:**
- Consumes `VoiceVACCore`.
- Produces scheme `VoiceVAC`, executable `VoiceVAC`, product `Voice VAC.app`, and a main-actor store that later panel tasks observe.

- [ ] **Step 1: Write the failing bundle contract test**

```swift
@MainActor
func testBundleContract() throws {
    let info = try XCTUnwrap(Bundle.main.infoDictionary)
    XCTAssertEqual(info["CFBundleDisplayName"] as? String, "Voice VAC")
    XCTAssertEqual(info["CFBundleIdentifier"] as? String, "io.voivox.app")
    XCTAssertEqual(info["LSUIElement"] as? Bool, true)
    XCTAssertEqual(NSApp.activationPolicy(), .accessory)
}
```

- [ ] **Step 2: Generate the project and verify RED**

```bash
(cd native/macos/App && xcodegen generate)
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC test
```

Expected: build/test fails because the App target and source do not yet exist.

- [ ] **Step 3: Implement the App target and exact Info.plist**

```xml
<key>CFBundleDisplayName</key><string>Voice VAC</string>
<key>CFBundleIdentifier</key><string>io.voivox.app</string>
<key>CFBundleExecutable</key><string>VoiceVAC</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>26.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSPrincipalClass</key><string>NSApplication</string>
```

`AppDelegate.applicationDidFinishLaunching` must set `.accessory`, create the store/status item, and call a window coordinator. It must not create `NSWindowController` with a titled main window.

- [ ] **Step 4: Add a reproducible build script**

```bash
#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root/native/macos/App"
xcodegen generate
xcodebuild -project VoiceVAC.xcodeproj -scheme VoiceVAC -configuration "${CONFIGURATION:-Debug}" -destination 'platform=macOS,arch=arm64' -derivedDataPath ../.derived/VoiceVAC CODE_SIGNING_ALLOWED=NO build
```

- [ ] **Step 5: Build, inspect, launch-smoke, and commit**

```bash
bash scripts/build-native-app.sh
plutil -extract LSUIElement raw -o - "native/macos/.derived/VoiceVAC/Build/Products/Debug/Voice VAC.app/Contents/Info.plist"
test "$(plutil -extract LSUIElement raw -o - "native/macos/.derived/VoiceVAC/Build/Products/Debug/Voice VAC.app/Contents/Info.plist")" = true
git add native/macos/App scripts/build-native-app.sh
git commit -m "feat: add native Voice VAC app bundle"
```

### Task 3: Implement Liquid Glass panels and multi-screen coordination

**Files:**
- Create: `native/macos/App/VoiceVAC/Screens/ScreenProviding.swift`
- Create: `native/macos/App/VoiceVAC/Screens/NSScreenProvider.swift`
- Create: `native/macos/App/VoiceVAC/Overlay/PanelRole.swift`
- Create: `native/macos/App/VoiceVAC/Overlay/PanelControlling.swift`
- Create: `native/macos/App/VoiceVAC/Overlay/PanelFactory.swift`
- Create: `native/macos/App/VoiceVAC/Overlay/OverlayCoordinator.swift`
- Create: `native/macos/App/VoiceVAC/Panels/CapsulePanel.swift`
- Create: `native/macos/App/VoiceVAC/Panels/HoseOverlayPanel.swift`
- Create: `native/macos/App/VoiceVAC/Panels/NozzleHitPanel.swift`
- Create: `native/macos/App/VoiceVAC/Panels/TranscriptPanel.swift`
- Create: `native/macos/App/VoiceVAC/Panels/URLInputPanel.swift`
- Create: `native/macos/App/VoiceVAC/Views/CapsuleGlassView.swift`
- Create: `native/macos/App/VoiceVAC/Views/TranscriptGlassView.swift`
- Create: `native/macos/App/VoiceVACAppTests/PanelConfigurationTests.swift`
- Create: `native/macos/App/VoiceVACAppTests/ScreenReconcilerTests.swift`

**Interfaces:**
- Produces one capsule panel, one nozzle panel, one transcript panel, and one click-through hose panel per screen.
- Coordinator depends only on `ScreenProviding`, `PanelFactory`, `OverlayLayoutEngine`, and `CapsulePlacementStore`.

- [ ] **Step 1: Write failing panel and screen reconciliation tests**

Assert exact configurations:

```swift
XCTAssertEqual(capsule.styleMask, [.borderless, .nonactivatingPanel])
XCTAssertEqual(capsule.frame.size, CGSize(width: 406, height: 116))
XCTAssertFalse(capsule.isOpaque)
XCTAssertEqual(capsule.backgroundColor, .clear)
XCTAssertTrue(capsule.hidesOnDeactivate == false)
XCTAssertTrue(capsule.collectionBehavior.contains(.canJoinAllSpaces))
XCTAssertTrue(capsule.collectionBehavior.contains(.fullScreenAuxiliary))
XCTAssertTrue(hose.ignoresMouseEvents)
```

Fake-screen tests must prove screen add/remove is idempotent and no giant combined overlay is created.

- [ ] **Step 2: Verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC -only-testing:VoiceVACAppTests/PanelConfigurationTests -only-testing:VoiceVACAppTests/ScreenReconcilerTests test
```

- [ ] **Step 3: Implement the panel factory and system glass**

```swift
let glass = NSGlassEffectView()
glass.style = .clear
glass.cornerRadius = 58
glass.tintColor = NSColor.white.withAlphaComponent(0.08)
glass.contentView = capsuleContentView
```

Do not use nonexistent `isInteractive`. Put all child content in `contentView`. Order panels as Chrome < hose overlay < capsule/nozzle < transcript.

- [ ] **Step 4: Implement drag-to-move and normalized position persistence**

Only dragging the unoccupied glass background moves the capsule. Red button/nozzle hit regions must consume their own pointer events. Clamp saved positions after display changes.

- [ ] **Step 5: Run App tests, open the App, and commit**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC test
open "native/macos/.derived/VoiceVAC/Build/Products/Debug/Voice VAC.app"
git add native/macos/App
git commit -m "feat: add Voice VAC liquid glass overlays"
```

### Task 4: Implement the active-length orientation hose solver

**Files:**
- Create: `native/macos/Sources/VoiceVACCore/Hose/HoseConfiguration.swift`
- Create: `native/macos/Sources/VoiceVACCore/Hose/HoseNode.swift`
- Create: `native/macos/Sources/VoiceVACCore/Hose/HoseSnapshot.swift`
- Create: `native/macos/Sources/VoiceVACCore/Hose/HoseRod.swift`
- Create: `native/macos/Sources/VoiceVACCore/Hose/XPBDConstraint.swift`
- Create: `native/macos/Tests/VoiceVACCoreTests/HoseRodTests.swift`

**Interfaces:**
- Produces deterministic `HoseSnapshot` samples consumed by RealityKit and Metal renderers.
- Does not import AppKit or RealityKit.

- [ ] **Step 1: Write failing physics tests**

```swift
@Test("deployment adds natural-length segments instead of stretching the rod")
func activeLengthDeployment() {
    var rod = HoseRod(configuration: .voiceVAC, seed: 42)
    rod.pinRoot(SIMD3(0, 0, 0), orientation: .identity)
    rod.pinTip(SIMD3(480, 0, 0), orientation: .identity)
    rod.setActiveLength(500)
    rod.step(deltaTime: 1.0 / 120.0, iterations: 12)

    #expect(rod.activeNodeCount > 10)
    #expect(rod.maximumSegmentStrain < 0.08)
}

@Test("retraction monotonically reduces active length")
func retraction() {
    var rod = HoseRod(configuration: .voiceVAC, seed: 42)
    rod.setActiveLength(800)
    let before = rod.activeLength
    rod.retract(by: 120)
    #expect(rod.activeLength == before - 120)
}
```

Also test fixed-seed determinism, root/tip pinning, finite positions after 600 frames, maximum 72 nodes, and full-screen `2200 pt` deployment.

- [ ] **Step 2: Verify RED**

```bash
swift test --package-path native/macos --filter HoseRodTests
```

- [ ] **Step 3: Implement XPBD stretch/bend/orientation constraints**

Use:

```swift
let alphaTilde = compliance / (deltaTime * deltaTime)
let deltaLambda = (-constraint - alphaTilde * lambda) / (weightedGradient + alphaTilde)
```

Nodes carry `SIMD3<Double>` positions and `simd_quatd` orientations. Newly deployed nodes appear at natural segment spacing from the root reservoir. Low-frequency seeded curvature is an input rest shape; per-frame random numbers are forbidden.

- [ ] **Step 4: Run a 600-frame stability benchmark and commit**

```bash
swift test --package-path native/macos --filter HoseRodTests
git add native/macos/Sources/VoiceVACCore/Hose native/macos/Tests/VoiceVACCoreTests/HoseRodTests.swift
git commit -m "feat: add Voice VAC active-length hose solver"
```

### Task 5: Build and validate the final Blender asset contract

**Files:**
- Modify: `tools/blender/scripts/build_voice_vac.py`
- Modify: `tools/blender/scripts/validate_voice_vac.py`
- Modify: `tools/blender/scripts/render_voice_vac_preview.py`
- Modify: `tools/blender/assets/voice-vac-machine.blend`
- Create: `tools/blender/assets/VoiceVACDevice.usdz`
- Create: `tools/blender/assets/VoiceVACHose.usdz`
- Create: `tools/blender/assets/asset-contract.json`
- Create: `docs/assets/voice-vac-native-preview.png`
- Create: `native/macos/App/VoiceVACAppTests/RealityAssetContractTests.swift`

**Interfaces:**
- Produces stable nodes `VAC_DEVICE_ROOT`, `VAC_PORT`, `VAC_NOZZLE`, `VAC_NOZZLE_TIP`, `VAC_BUTTON_BASE`, `VAC_BUTTON_CAP`, `VAC_HOSE_ROOT`, `VAC_HOSE_SKIN`, and `VAC_HOSE_JOINT_00...63`.

- [ ] **Step 1: Write the failing Blender and Swift asset validators**

```python
REQUIRED_OBJECTS = {
    "VAC_DEVICE_ROOT", "VAC_PORT", "VAC_NOZZLE", "VAC_NOZZLE_TIP",
    "VAC_BUTTON_BASE", "VAC_BUTTON_CAP", "VAC_HOSE_ROOT", "VAC_HOSE_SKIN"
}
REQUIRED_JOINTS = {f"VAC_HOSE_JOINT_{index:02d}" for index in range(64)}
missing = (REQUIRED_OBJECTS | REQUIRED_JOINTS) - {obj.name for obj in bpy.data.objects}
if missing:
    raise SystemExit(f"Missing Voice VAC asset nodes: {sorted(missing)}")
```

Swift test loads the contract JSON and asserts the bundled USDZ resource exists and lists every node.

- [ ] **Step 2: Verify RED against the current asset**

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background tools/blender/assets/voice-vac-machine.blend --python tools/blender/scripts/validate_voice_vac.py
```

Expected: validation fails because the existing Electron-era model lacks the final node/joint contract.

- [ ] **Step 3: Enable the installed Blender MCP bridge and rebuild the model**

Use Blender 5.2 LTS for iterative viewport/render inspection. The device must contain a vertically docked rectangular duckbill, rotary collar, 64-joint corrugated hose, red physical cap/button base, and PBR materials. Do not keep the old primitive machine body as a production fallback.

- [ ] **Step 4: Export USDZ, render the native preview, and validate**

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/scripts/build_voice_vac.py -- --output-dir tools/blender/assets
/Applications/Blender.app/Contents/MacOS/Blender --background tools/blender/assets/voice-vac-machine.blend --python tools/blender/scripts/validate_voice_vac.py
/Applications/Blender.app/Contents/MacOS/Blender --background tools/blender/assets/voice-vac-machine.blend --python tools/blender/scripts/render_voice_vac_preview.py -- --output docs/assets/voice-vac-native-preview.png
```

- [ ] **Step 5: Copy resources into the App, run contract tests, and commit**

```bash
mkdir -p native/macos/App/VoiceVAC/Resources/Reality
ditto tools/blender/assets/VoiceVACDevice.usdz native/macos/App/VoiceVAC/Resources/Reality/VoiceVACDevice.usdz
ditto tools/blender/assets/VoiceVACHose.usdz native/macos/App/VoiceVAC/Resources/Reality/VoiceVACHose.usdz
ditto tools/blender/assets/asset-contract.json native/macos/App/VoiceVAC/Resources/Reality/asset-contract.json
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC -only-testing:VoiceVACAppTests/RealityAssetContractTests test
git add tools/blender native/macos/App/VoiceVAC/Resources/Reality native/macos/App/VoiceVACAppTests/RealityAssetContractTests.swift docs/assets/voice-vac-native-preview.png
git commit -m "feat: add Voice VAC native 3D asset rig"
```

### Task 6: Render the device and hose across native overlay panels

**Files:**
- Create: `native/macos/App/VoiceVAC/Reality/RealityAssetLoading.swift`
- Create: `native/macos/App/VoiceVAC/Reality/RealityAssetLoader.swift`
- Create: `native/macos/App/VoiceVAC/Reality/DeviceRealityView.swift`
- Create: `native/macos/App/VoiceVAC/Reality/HoseRealityViewport.swift`
- Create: `native/macos/App/VoiceVAC/Reality/HoseRigController.swift`
- Create: `native/macos/App/VoiceVAC/Reality/ScreenPointProjector.swift`
- Create: `native/macos/App/VoiceVACAppTests/HoseRigControllerTests.swift`
- Create: `native/macos/App/VoiceVACAppTests/TransparentCompositionTests.swift`

**Interfaces:**
- Consumes final USDZ nodes and `HoseSnapshot`.
- Produces a docked device view and one synchronized hose viewport per display.

- [ ] **Step 1: Write failing rig and projection tests**

Test that 64 poses map one-to-one to `VAC_HOSE_JOINT_00...63`, screen points convert through each display frame without Retina point/pixel confusion, and missing nodes throw a visible asset-contract error.

- [ ] **Step 2: Verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC -only-testing:VoiceVACAppTests/HoseRigControllerTests test
```

- [ ] **Step 3: Implement RealityKit loading and joint transforms**

```swift
let entity = try await Entity(named: "VoiceVACHose", in: .main)
let joints = try contract.jointNames.map { name in
    guard let joint = entity.findEntity(named: name) else {
        throw RealityAssetError.missingNode(name)
    }
    return joint
}
```

All per-screen viewports consume the same immutable `HoseRenderSnapshot`; only camera/projection changes per screen.

- [ ] **Step 4: Validate transparent composition**

Run the App above a high-contrast moving background. Empty RealityKit/overlay areas must have transparent alpha and `ignoresMouseEvents=true`. If RealityKit produces an opaque drawable, replace only the hose viewport with transparent `MTKView`; retain RealityKit for capsule assets.

- [ ] **Step 5: Run tests, record a screenshot, and commit**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC test
git add native/macos/App
git commit -m "feat: render Voice VAC across native overlays"
```

### Task 7: Implement nozzle drag, URL animation, yellow hold, and controlled retraction

**Files:**
- Create: `native/macos/App/VoiceVAC/Interaction/NozzleDragCoordinator.swift`
- Create: `native/macos/App/VoiceVAC/Interaction/NozzlePasteboard.swift`
- Create: `native/macos/App/VoiceVAC/Interaction/NozzleURLAnimator.swift`
- Create: `native/macos/App/VoiceVAC/Interaction/NozzleRetractionController.swift`
- Create: `native/macos/App/VoiceVAC/Views/PhysicalButtonView.swift`
- Create: `native/macos/App/VoiceVACAppTests/NozzleInteractionTests.swift`
- Create: `native/macos/App/VoiceVACUITests/VoiceVACLaunchTests.swift`

**Interfaces:**
- Produces trusted native drag payload `VOICE_VAC_DROP_V1|<sessionUUID>|<base64urlNonce>`.
- Emits core actions only; Chrome command transport is added by the integration plan.

- [ ] **Step 1: Write failing interaction tests**

Cover exact behavior:

```swift
func testWarningDoesNotRetractUntilX() async {
    store.send(.beginNozzleDrag(at: CGPoint(x: 10, y: 10)))
    store.send(.targetRejected(.noPlayableMedia))
    clock.advance(by: .seconds(5))
    XCTAssertEqual(store.state.phase, .warningYellow)
    XCTAssertNotNil(store.state.nozzleGlobalPoint)

    store.send(.retractRequested)
    XCTAssertEqual(store.state.phase, .retracting)
}
```

Also test vertical-to-horizontal nozzle rotation, deterministic four-stage double-click timeline, button pressed depth during transcription, pause/resume travel, and monotonic active-length retraction.

- [ ] **Step 2: Verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC -only-testing:VoiceVACAppTests/NozzleInteractionTests test
```

- [ ] **Step 3: Implement native drag and pasteboard token**

Use `NSDraggingSession` with `NSPasteboard.PasteboardType.string`; never put the target URL into the drag payload. Update the hose solver from global pointer coordinates while the drag is active.

- [ ] **Step 4: Implement the four-stage URL animation and input panel**

Use a deterministic keyframe timeline for unlock/lift, in-plane mouth rotation, C extension, and reverse-C/S curl. Secondary hose lag comes from the solver. The URL field becomes key only while visible and accepts Enter/Start.

- [ ] **Step 5: Implement `×` controlled retraction and UI launch test**

The `×` follows the hose tangent 32–48 pt above the nozzle. If capturing, emit stop/flush before reducing active length. Retraction completes only when the nozzle re-docks vertically.

- [ ] **Step 6: Run native tests, package the Phase A App, and commit**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVAC -destination 'platform=macOS,arch=arm64' -derivedDataPath native/macos/.derived/VoiceVAC test
bash scripts/build-native-app.sh
codesign --force --sign - --timestamp=none "native/macos/.derived/VoiceVAC/Build/Products/Debug/Voice VAC.app"
codesign --verify --deep --strict "native/macos/.derived/VoiceVAC/Build/Products/Debug/Voice VAC.app"
git add native/macos/App
git commit -m "feat: complete Voice VAC native device interactions"
```
