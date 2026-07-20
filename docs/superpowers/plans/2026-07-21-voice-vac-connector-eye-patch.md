# Voice VAC Connector and Eye-Patch Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the visible hose-to-nozzle gap in every deployed pose and replace spherical side eyes with shallow toy-eye appliques.

**Architecture:** Keep the nozzle panel center at the authored rear socket pivot. Make `NozzlePresentationKinematics` advance the hose endpoint 8 pt into that pivot, while Blender authors a longer/wider rubber collar and flattened eye/pupil meshes below the duckbill runtime node.

**Tech Stack:** Swift 6.3, CoreGraphics, RealityKit, Metal, XCTest, Blender 5.2 LTS, USDZ.

## Global Constraints

- Docked eyes remain hidden.
- Eyes become visible only after the head leaves the dock.
- The hose endpoint enters the rear socket by exactly 8 pt along the incoming tangent.
- The collar must remain wider than the largest hose rib.
- Eye and pupil depth must each remain below 35% of their widest face dimension.
- Existing drag, double-click URL input, and retraction behavior must remain unchanged.

---

### Task 1: Correct the runtime connector endpoint

**Files:**
- Modify: `native/macos/App/VoiceVAC/Interaction/NozzleDragCoordinator.swift`
- Modify: `native/macos/App/VoiceVACAppTests/NozzleInteractionTests.swift`

**Interfaces:**
- Produces `NozzlePresentationKinematics.hoseSocketInsertionDepth`.
- `rearCylinderPoint(forNozzleCenter:hoseTangent:)` returns `center + normalizedTangent * hoseSocketInsertionDepth`.

- [ ] **Step 1: Write the failing endpoint test**

```swift
let center = CGPoint(x: 200, y: 100)
let endpoint = NozzlePresentationKinematics.rearCylinderPoint(
    forNozzleCenter: center,
    hoseTangent: CGVector(dx: 3, dy: 4)
)
XCTAssertEqual(endpoint.x, 204.8, accuracy: 0.001)
XCTAssertEqual(endpoint.y, 106.4, accuracy: 0.001)
```

- [ ] **Step 2: Run the test and verify RED**

Run the `NozzleInteractionTests` XCTest bundle. Expected: the current endpoint is behind the panel center and fails both coordinates.

- [ ] **Step 3: Implement the insertion endpoint**

Replace the rear offset with an 8 pt forward insertion along the normalized tangent. Keep every caller on this shared helper.

- [ ] **Step 4: Run the focused test and verify GREEN**

Require `NozzleInteractionTests` to finish with zero failures.

### Task 2: Re-author the captured collar and applique eyes

**Files:**
- Modify: `tools/blender/scripts/build_voice_vac.py`
- Modify: `tools/blender/scripts/validate_voice_vac.py`
- Modify: `native/macos/App/VoiceVACAppTests/RealityAssetContractTests.swift`
- Regenerate: `tools/blender/assets/voice-vac-machine.blend`
- Regenerate: `tools/blender/assets/voice-vac-machine.glb`
- Regenerate: `tools/blender/assets/VoiceVACDevice.usdz`
- Regenerate: `tools/blender/assets/VoiceVACHose.usdz`
- Regenerate: `tools/blender/assets/asset-contract.json`
- Regenerate: `native/macos/App/VoiceVAC/Resources/Reality/*`
- Regenerate: `docs/assets/voice-vac-native-preview.png`

**Interfaces:**
- Preserves entity names `VAC_NOZZLE_COLLAR`, `VAC_NOZZLE_EYE_L/R`, and `VAC_NOZZLE_PUPIL_L/R`.
- Adds authored mesh metadata `voice_vac_eye_style = "applique"` and `voice_vac_connector_role = "hose_capture"`.

- [ ] **Step 1: Write failing asset tests**

Load the bundled USDZ and assert eye/pupil minimum extent divided by maximum extent is below `0.35`. Assert the exported USD text contains both authored metadata markers.

- [ ] **Step 2: Run the asset tests and verify RED**

Expected: the current nearly spherical eye meshes fail the flatness ratio, and the metadata is absent.

- [ ] **Step 3: Author the corrected geometry**

Increase the collar length and radius around the rear socket. Replace each lathed eye sphere with a capped superellipse loft whose face is rounded and whose thickness is 2.4 mm or less. Add a thinner, offset pupil applique above each warm-white base.

- [ ] **Step 4: Rebuild and validate assets**

Run Blender headlessly, copy byte-identical USDZ/contract assets into the App resources, render the preview, and require the validator to report the model, hierarchy, flatness, collar, and 64-joint hose contract as valid.

- [ ] **Step 5: Run full regression and real desktop QA**

Run `swift test --package-path native/macos`, the 98-test `VoiceVACAppTests` suite, and `scripts/build-native-app.sh`. Open the Release App, drag the head diagonally, inspect a close screenshot of the connector and eye side, retract, and confirm the dock remains unchanged.
