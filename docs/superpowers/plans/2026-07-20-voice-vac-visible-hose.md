# Voice VAC Visible Hose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the white corrugated vacuum hose as a continuously visible desktop character in idle, deploy, attached, and retraction states.

**Architecture:** Keep the XPBD `HoseRod` and the existing 64-joint Metal renderer. Add presentation-level stowed and deployed length rules at `HoseRenderSession`, then request visual deployment before the native drag transport starts. `HoseOverlayPanel` stays full-screen and transparent so the rendered hose can cross other app windows.

**Tech Stack:** Swift 6, AppKit transparent `NSPanel`, Metal, XPBD hose simulation, XCTest, Swift Testing.

## Global Constraints

- Keep the capsule at exactly 406 × 116 points.
- Use the real `VoiceVACHose.meshbin` / Metal skinning path; do not replace it with a 2D line.
- Do not change private tab-audio or MCP behaviour.
- Failed Chrome targets leave the hose on screen until explicit retraction.

---

### Task 1: Make the stowed hose visibly non-degenerate

**Files:**

- Modify: `native/macos/App/VoiceVAC/Reality/HoseRenderSession.swift`
- Modify: `native/macos/App/VoiceVACAppTests/HoseRigControllerTests.swift`

**Interfaces:**

- Produces: `HoseRenderSession.stowedActiveLength` and `dock(in:)` publishing a multi-joint snapshot.
- Consumes: `HoseConfiguration.naturalSegmentLength`, `HoseRenderSnapshotSource.latest`.

- [ ] **Step 1: Write the failing test**

```swift
func testDockPublishesAVisibleStowedHoseInsteadOfOneSegment() throws {
    let source = HoseRenderSnapshotSource()
    let session = HoseRenderSession(source: source, seed: 81)
    try session.dock(in: CGRect(x: 300, y: 120, width: 96, height: 96))
    XCTAssertGreaterThan(session.rod.activeLength, session.rod.configuration.naturalSegmentLength * 2.5)
    XCTAssertNotNil(source.latest)
}
```

- [ ] **Step 2: Verify RED**

Run: `xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit -only-testing:VoiceVACAppTests/HoseRigControllerTests/testDockPublishesAVisibleStowedHoseInsteadOfOneSegment test CODE_SIGNING_ALLOWED=NO`

Expected: fail because `dock(in:)` uses one natural segment.

- [ ] **Step 3: Implement GREEN**

```swift
var stowedActiveLength: Double {
    min(rod.configuration.naturalSegmentLength * 4, rod.configuration.maximumActiveLength)
}
```

Configure a four-segment stowed pose at the port, then publish it.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: pass.

### Task 2: Add visual slack before native drag transport

**Files:**

- Modify: `native/macos/App/VoiceVAC/Reality/HoseRenderSession.swift`
- Modify: `native/macos/App/VoiceVAC/Interaction/VoiceVACInteractionRuntime.swift`
- Modify: `native/macos/App/VoiceVACAppTests/ProductionInteractionIntegrationTests.swift`

**Interfaces:**

- Produces: `HoseRenderSession.deployVisual(toward:)`.
- Consumes: `dockPoint`, `HoseRenderSession.step(deltaTime:)`.

- [ ] **Step 1: Write the failing test**

```swift
func testVisualDeploymentUsesSlackInsteadOfATautLine() throws {
    let session = HoseRenderSession(source: HoseRenderSnapshotSource(), seed: 82)
    try session.dock(in: CGRect(x: 0, y: 0, width: 96, height: 96))
    try session.deployVisual(toward: CGPoint(x: 420, y: 150))
    let span = hypot(420 - 48, 150 - 48)
    XCTAssertGreaterThanOrEqual(session.rod.activeLength, span * 1.18)
}
```

- [ ] **Step 2: Verify RED**

Run: `xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit -only-testing:VoiceVACAppTests/ProductionInteractionIntegrationTests/testVisualDeploymentUsesSlackInsteadOfATautLine test CODE_SIGNING_ALLOWED=NO`

Expected: fail because `deployVisual(toward:)` does not exist.

- [ ] **Step 3: Implement GREEN**

```swift
func deployVisual(toward point: CGPoint) throws {
    let span = hypot(point.x - rootPoint.x, point.y - rootPoint.y)
    let length = min(max(span * 1.18, stowedActiveLength), rod.configuration.maximumActiveLength)
    try updateDeployment(tipGlobalPoint: point, activeLength: length, orientation: .identity)
    try step(deltaTime: 1.0 / 60.0)
}
```

Call it at visual drag start before `NSView.beginDraggingSession` can succeed or fail.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: pass.

### Task 3: Restore the stored hose after retraction

**Files:**

- Modify: `native/macos/App/VoiceVAC/Interaction/VoiceVACInteractionRuntime.swift`
- Modify: `native/macos/App/VoiceVACAppTests/NozzleInteractionTests.swift`

**Interfaces:**

- Produces: a terminal retraction that calls `HoseRenderSession.dock(in:)`.
- Consumes: `requestRetraction()` and the existing `warningYellow` state.

- [ ] **Step 1: Write the failing test**

```swift
func testRetractionRestoresVisibleStowedLength() async throws {
    // After retraction completes, `session.rod.activeLength` remains above 2.5 segments.
    XCTAssertGreaterThan(session.rod.activeLength, session.rod.configuration.naturalSegmentLength * 2.5)
}
```

- [ ] **Step 2: Verify RED**

Run: `xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit -only-testing:VoiceVACAppTests/NozzleInteractionTests/testRetractionRestoresVisibleStowedLength test CODE_SIGNING_ALLOWED=NO`

Expected: fail because retraction finishes in a one-segment pose.

- [ ] **Step 3: Implement GREEN**

At terminal retraction, restore the docked `HoseRenderSession` pose before hiding the close button.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command. Expected: pass.

### Task 4: Visual proof and package build

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Add the visual acceptance sequence**

```markdown
1. Launch the native App and verify a corrugated white segment at the port.
2. Drag the mouth 300+ points and verify a curved hose persists behind it.
3. Reject a target and verify yellow warning does not hide the hose.
4. Click × and verify retraction restores the stored segment.
```

- [ ] **Step 2: Verify complete native suite**

Run: `xcodebuild -project native/macos/App/VoiceVAC.xcodeproj -scheme VoiceVACUnit -configuration Debug -sdk macosx test CODE_SIGNING_ALLOWED=NO`

Expected: pass.

- [ ] **Step 3: Package and inspect**

Run: `npm run build:native`

Launch `native/macos/build/Voice VAC.app` and inspect the overlay with Computer Use.

## Self-review

- Every approved visual state maps to a task.
- The implementation uses the existing 3D skinned mesh and retains audio/MCP boundaries.
- All new behaviour has a test-first verification step.
