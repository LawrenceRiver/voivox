# Voice VAC Mouth-Embedded URL Interaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the curved, detached URL bubble interaction with a straight depth-first suction-head animation whose input field is embedded in the widened 3D mouth.

**Architecture:** Keep manual drag on the existing XPBD soft-hose path, and add a deterministic straight URL-presentation path. Make `NozzleHitPanel` own the interactive mouth field while RealityKit owns the authored head, side eyes, late turn, and duckbill expansion.

**Tech Stack:** Swift 6.3, AppKit, RealityKit, Metal hose rendering, XCTest, Blender 5.2 LTS, USDZ.

## Global Constraints

- User-visible brand is exactly `Voice VAC`.
- Capsule size remains exactly `406 × 116 pt`.
- Docked mouth points out of the screen, is vertical, and shows no eyes.
- URL mode starts with a straight tube; manual drag retains the flexible C/S tube.
- The final embedded mouth input is `280–320 pt` wide.
- No separate production URL bubble or transcript-positioned URL panel may appear.
- Existing transcript, capture, drag authorization, and retraction behavior must remain intact.

---

### Task 1: Encode the corrected dock and URL animation contract

**Files:**
- Modify: `native/macos/App/VoiceVACAppTests/NozzleInteractionTests.swift`
- Modify: `native/macos/App/VoiceVACAppTests/ProductionInteractionIntegrationTests.swift`
- Modify: `native/macos/App/VoiceVAC/Interaction/NozzleURLAnimator.swift`
- Modify: `native/macos/App/VoiceVAC/Reality/VoiceVACDeviceInteractionController.swift`

**Interfaces:**
- Produces `NozzleURLAnimationFrame.depthRetreat`, `operatingPoseProgress`, `verticalLift`, `mouthTurnProgress`, `mouthExpansion`, and `showsEmbeddedInput`.
- `VoiceVACDeviceInteractionController.applyURLAnimationFrame(_:)` consumes the frame and controls head pose, eye visibility, and duckbill scale.

- [ ] **Step 1: Write failing animation and entity tests**

```swift
let first = animator.frame(at: animator.timeline[0].duration)
XCTAssertGreaterThan(first.depthRetreat, 0.03)
XCTAssertEqual(first.translation.x, 0, accuracy: 0.001)
XCTAssertEqual(first.verticalLift, 0, accuracy: 0.001)
XCTAssertEqual(first.operatingPoseProgress, 1, accuracy: 0.001)

let final = animator.frame(at: animator.duration)
XCTAssertEqual(final.mouthTurnProgress, 1, accuracy: 0.001)
XCTAssertGreaterThanOrEqual(final.mouthExpansion, 2)
XCTAssertTrue(final.showsEmbeddedInput)
```

Also load the real entity and assert docked eye entities are disabled, lifted eyes are enabled, the docked mouth normal points toward +Z, and the final mouth normal points toward +Z after the late turn.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit \
  -sdk macosx -derivedDataPath /tmp/voice-vac-mouth-red CODE_SIGNING_ALLOWED=NO \
  -only-testing:VoiceVACAppTests/NozzleInteractionTests test
```

Expected: compilation or assertions fail because the staged properties and visibility behavior do not exist.

- [ ] **Step 3: Implement the four-stage deterministic frame**

Use zero horizontal travel during the first two stages. Stage one combines depth retreat and dock-to-horizontal rotation. Stage two adds only vertical lift. Stage three holds the straight pose before applying the late head turn. Stage four expands the duckbill and reveals the embedded field.

- [ ] **Step 4: Apply poses and visibility to the real RealityKit entities**

Find `VAC_NOZZLE_DUCKBILL`, both eye roots, and the nozzle root once during load. Dock disables eyes and restores duckbill scale to one. URL frames enable eyes after the first phase, interpolate dock-to-operating transforms, apply the late world-space turn, and scale only the duckbill X axis.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run the Step 2 command and require zero failures.

### Task 2: Add a URL-only straight hose presentation

**Files:**
- Modify: `native/macos/App/VoiceVACAppTests/HoseRigControllerTests.swift`
- Modify: `native/macos/App/VoiceVAC/Reality/HoseRenderSession.swift`
- Modify: `native/macos/App/VoiceVAC/Interaction/VoiceVACInteractionRuntime.swift`

**Interfaces:**
- Produces `HoseRenderSession.deployStraightForURL(toward:orientation:)`.
- `VoiceVACInteractionRuntime.advanceURLAnimation(deltaTime:)` updates the hose endpoint every frame and keeps manual drag on `deployVisual`.

- [ ] **Step 1: Write a failing straight-centerline test**

```swift
try session.dock(in: CGRect(x: 100, y: 100, width: 96, height: 96))
try session.deployStraightForURL(toward: CGPoint(x: 148, y: 300))
let line = try XCTUnwrap(source.latest?.centerline)
for point in line {
    XCTAssertEqual(point.x, line[0].x, accuracy: 0.001)
}
```

Add a regression assertion that `deployVisual` still produces measurable lateral sag.

- [ ] **Step 2: Run the hose test and verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit \
  -sdk macosx -derivedDataPath /tmp/voice-vac-hose-red CODE_SIGNING_ALLOWED=NO \
  -only-testing:VoiceVACAppTests/HoseRigControllerTests test
```

Expected: compilation fails because `deployStraightForURL` does not exist.

- [ ] **Step 3: Implement a presentation-mode centerline**

Add a private mode with `.stowed`, `.softDrag`, and `.straightURL`. In `.straightURL`, publish a root-to-tip linear interpolation with enough samples for the bellows mesh; do not add the handmade sine offset. Preserve the XPBD endpoints and physical active-length bounds.

- [ ] **Step 4: Drive the straight hose from the URL timeline**

At each URL frame, calculate the rear-cylinder point from the vertical straight tangent and call `deployStraightForURL`. The nozzle panel and hose endpoint must use the same global point. Dismissal or retraction returns to the normal dock/retraction paths.

- [ ] **Step 5: Run the hose and production integration tests and verify GREEN**

Require the straight URL test and the existing flexible-drag tests to pass together.

### Task 3: Embed the URL field inside the suction mouth

**Files:**
- Modify: `native/macos/App/VoiceVACAppTests/PanelConfigurationTests.swift`
- Modify: `native/macos/App/VoiceVACAppTests/ScreenReconcilerTests.swift`
- Modify: `native/macos/App/VoiceVACAppTests/ProductionInteractionIntegrationTests.swift`
- Modify: `native/macos/App/VoiceVAC/Panels/NozzleHitPanel.swift`
- Modify: `native/macos/App/VoiceVAC/Interaction/NozzleURLAnimator.swift`
- Modify: `native/macos/App/VoiceVAC/Overlay/OverlayCoordinator.swift`
- Modify: `native/macos/App/VoiceVAC/Overlay/PanelFactory.swift`
- Remove: `native/macos/App/VoiceVAC/Panels/URLInputPanel.swift`

**Interfaces:**
- `NozzleHitPanel.setEmbeddedURLInputPresented(_:expansion:)` owns focus and layout.
- `VoiceVACInteractionPresenting.setURLInputPresented(_:)` delegates to the nozzle panel, not a separate panel.

- [ ] **Step 1: Write failing ownership and layout tests**

Assert that the live factory does not create a `URLInputPanel`, the embedded field is a descendant of `NozzleHitPanel.contentView`, its accessibility identifier remains `voice-vac-url-field`, it is hidden while docked, and its final frame width is between 280 and 320 pt inside the expanded mouth panel.

- [ ] **Step 2: Run panel tests and verify RED**

```bash
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit \
  -sdk macosx -derivedDataPath /tmp/voice-vac-panel-red CODE_SIGNING_ALLOWED=NO \
  -only-testing:VoiceVACAppTests/PanelConfigurationTests \
  -only-testing:VoiceVACAppTests/ScreenReconcilerTests test
```

Expected: assertions fail because production still owns a separate URL panel.

- [ ] **Step 3: Move the existing accessible controls into the nozzle panel**

Keep the real `NSTextField` and Start `NSButton`. Place them over the projected dark mouth, with no glass bubble background, clip them to a rounded mouth mask, and size the final panel to contain the expanded 3D duckbill. Keep Return submission and focus behavior.

- [ ] **Step 4: Remove separate production URL-panel coordination**

The coordinator must no longer create, frame, order, or hide `.urlInput`. URL presentation toggles the embedded nozzle control while transcript visibility remains mutually exclusive during input.

- [ ] **Step 5: Run focused panel and integration tests and verify GREEN**

Require the Step 2 suites plus `ProductionInteractionIntegrationTests` to pass.

### Task 4: Re-author the dock, duckbill, and side eyes, then package

**Files:**
- Modify: `tools/blender/scripts/build_voice_vac.py`
- Modify: `tools/blender/scripts/validate_voice_vac.py`
- Modify: `native/macos/App/VoiceVACAppTests/RealityAssetContractTests.swift`
- Regenerate: `tools/blender/assets/voice-vac-machine.blend`
- Regenerate: `tools/blender/assets/voice-vac-machine.glb`
- Regenerate: `tools/blender/assets/VoiceVACDevice.usdz`
- Regenerate: `tools/blender/assets/VoiceVACHose.usdz`
- Regenerate: `tools/blender/assets/VoiceVACHose.meshbin`
- Regenerate: `tools/blender/assets/asset-contract.json`
- Regenerate: `native/macos/App/VoiceVAC/Resources/Reality/*`
- Regenerate: `docs/assets/voice-vac-native-preview.png`

**Interfaces:**
- Adds runtime node `VAC_NOZZLE_DUCKBILL`.
- Dock pose maps local mouth normal to +Z and local mouth width to screen Y.
- Operating pose maps the nozzle body up-screen with a horizontal duckbill.

- [ ] **Step 1: Write failing asset-contract tests**

Assert the duckbill node exists, the dock transform maps the local mouth normal `(0,-1,0)` toward camera +Z, the dock width axis is vertical, the operating pose is horizontal/up-screen, and both eyes are children of the side-shell/duckbill hierarchy.

- [ ] **Step 2: Run asset tests and verify RED**

Use a fresh derived-data directory and require the new node/orientation assertions to fail against the current asset.

- [ ] **Step 3: Re-author and export the model**

Create `VAC_NOZZLE_DUCKBILL`, parent the shell/tip/gasket/mouth and side eyes beneath it, rotate the dock to the confirmed vertical front-facing pose, author the horizontal operating pose, and place the eyes on the upper side face. Preserve the white hose and warm-ivory head material assignments.

- [ ] **Step 4: Validate, copy, and render**

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup \
  --python tools/blender/scripts/build_voice_vac.py -- --output-dir tools/blender/assets
/Applications/Blender.app/Contents/MacOS/Blender --background tools/blender/assets/voice-vac-machine.blend \
  --python tools/blender/scripts/validate_voice_vac.py -- \
  --contract tools/blender/assets/asset-contract.json \
  --preview docs/assets/voice-vac-native-preview.png
```

Copy the four runtime files into `native/macos/App/VoiceVAC/Resources/Reality` and verify byte identity.

- [ ] **Step 5: Run full verification and build**

```bash
swift test --package-path native/macos
xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit \
  -sdk macosx -derivedDataPath /tmp/voice-vac-mouth-final CODE_SIGNING_ALLOWED=NO test
scripts/build-native-app.sh
git diff --check
```

Expected: every command exits zero, the App suite reports zero failures, and `native/macos/build/Voice VAC.app` exists.

- [ ] **Step 6: Inspect with Computer Use and commit**

Open the Release App, verify the capsule and docked mouth render, exercise the double-click sequence, then commit and push the reviewed change on `codex/voice-vac-native`.

