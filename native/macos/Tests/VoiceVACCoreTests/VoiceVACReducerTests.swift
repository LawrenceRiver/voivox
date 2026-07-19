import CoreGraphics
import Foundation
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC state transitions")
struct VoiceVACReducerTests {
    @Test("video targets round-trip the exact Chrome geometry JSON shape")
    func videoTargetChromeJSONRoundTrip() throws {
        let json = Data(#"""
        {
          "id": "target-A",
          "kind": "html-media",
          "tag": "video",
          "frameId": 0,
          "documentId": "document-A",
          "viewportRect": {"x": 100, "y": 120, "width": 640, "height": 360},
          "screenRect": {"x": 300, "y": 220, "width": 640, "height": 360},
          "activationPoint": {"x": 420, "y": 280},
          "canDirectPlay": true
        }
        """#.utf8)

        let target = try JSONDecoder().decode(VideoTarget.self, from: json)
        #expect(target == .fixture)

        let encoded = try JSONEncoder().encode(target)
        let object = try #require(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        let viewportRect = try #require(object["viewportRect"] as? [String: Any])
        let screenRect = try #require(object["screenRect"] as? [String: Any])
        let activationPoint = try #require(object["activationPoint"] as? [String: Any])

        #expect(Set(object.keys) == [
            "id", "kind", "tag", "frameId", "documentId", "viewportRect",
            "screenRect", "activationPoint", "canDirectPlay"
        ])
        #expect(viewportRect.keys.sorted() == ["height", "width", "x", "y"])
        #expect(viewportRect["x"] as? Double == 100)
        #expect(viewportRect["y"] as? Double == 120)
        #expect(viewportRect["width"] as? Double == 640)
        #expect(viewportRect["height"] as? Double == 360)
        #expect(screenRect["x"] as? Double == 300)
        #expect(screenRect["y"] as? Double == 220)
        #expect(screenRect["width"] as? Double == 640)
        #expect(screenRect["height"] as? Double == 360)
        #expect(activationPoint.keys.sorted() == ["x", "y"])
        #expect(activationPoint["x"] as? Double == 420)
        #expect(activationPoint["y"] as? Double == 280)
    }

    @Test("a rejected target stays deployed and never begins retraction")
    func rejectedTargetStaysDeployed() {
        let deployed = VoiceVACState(
            phase: .dragging,
            nozzleGlobalPoint: CGPoint(x: 900, y: 500),
            attemptID: .attemptA
        )
        let failure = VoiceVACFailure(
            code: .noPlayableMedia,
            message: "No playable video found here."
        )

        let transition = VoiceVACReducer.reduce(
            state: deployed,
            action: .targetRejected(failure, attemptID: .attemptA)
        )

        #expect(transition.state.phase == .warningYellow)
        #expect(transition.state.nozzleGlobalPoint == CGPoint(x: 900, y: 500))
        #expect(transition.state.attemptID == .attemptA)
        #expect(transition.state.failure == failure)
        #expect(!transition.effects.contains(.beginRetraction))
    }

    @Test("an HTML target must be detected and resolved before capture")
    func htmlTargetRequiresReadiness() {
        let target = VideoTarget.fixture
        let dragging = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(
                at: CGPoint(x: 240, y: 180),
                attemptID: .attemptA
            )
        )
        let detected = VoiceVACReducer.reduce(
            state: dragging.state,
            action: .targetDetected(target, attemptID: .attemptA)
        )
        #expect(detected.state.phase == .targetDetected)
        #expect(detected.state.target == target)
        #expect(detected.effects.isEmpty)

        let prematurePress = VoiceVACReducer.reduce(
            state: detected.state,
            action: .primaryButtonPressed
        )
        #expect(prematurePress.state.phase == .targetDetected)
        #expect(prematurePress.effects.isEmpty)

        let ready = VoiceVACReducer.reduce(
            state: prematurePress.state,
            action: .targetResolved(target, attemptID: .attemptA)
        )
        #expect(ready.state.phase == .ready)
        #expect(ready.state.target == target)
        #expect(ready.effects.isEmpty)

        let started = VoiceVACReducer.reduce(
            state: ready.state,
            action: .primaryButtonPressed
        )
        #expect(started.state.phase == .transcribing)
        #expect(started.effects == [.startCapture(target)])
    }

    @Test("target detection cannot bypass nozzle dragging")
    func targetDetectionCannotBypassDragging() {
        let transition = VoiceVACReducer.reduce(
            state: .idle,
            action: .targetDetected(.fixture, attemptID: .attemptA)
        )

        #expect(transition.state == .idle)
        #expect(transition.effects.isEmpty)
    }

    @Test("target resolution cannot bypass the detection phase")
    func targetResolutionCannotBypassDetection() {
        let transition = VoiceVACReducer.reduce(
            state: .idle,
            action: .targetResolved(.fixture, attemptID: .attemptA)
        )

        #expect(transition.state == .idle)
        #expect(transition.effects.isEmpty)
    }

    @Test("target resolution is bound to the current attempt and pending identity")
    func targetResolutionRequiresMatchingHandshake() {
        let pendingTarget = VideoTarget.fixture
        let dragging = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(at: .zero, attemptID: .attemptA)
        ).state
        let detected = VoiceVACReducer.reduce(
            state: dragging,
            action: .targetDetected(pendingTarget, attemptID: .attemptA)
        ).state
        let mismatchedTargets = [
            VideoTarget.fixture(id: "target-B"),
            VideoTarget.fixture(documentID: "document-B"),
            VideoTarget.fixture(frameID: 7)
        ]

        for mismatchedTarget in mismatchedTargets {
            let transition = VoiceVACReducer.reduce(
                state: detected,
                action: .targetResolved(mismatchedTarget, attemptID: .attemptA)
            )
            #expect(transition.state == detected)
            #expect(transition.effects.isEmpty)
        }

        let staleAttempt = VoiceVACReducer.reduce(
            state: detected,
            action: .targetResolved(pendingTarget, attemptID: .attemptB)
        )
        #expect(staleAttempt.state == detected)
        #expect(staleAttempt.effects.isEmpty)
    }

    @Test("target detection from an old attempt is ignored")
    func targetDetectionRequiresCurrentAttempt() {
        let currentDrag = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(at: .zero, attemptID: .attemptB)
        ).state

        let transition = VoiceVACReducer.reduce(
            state: currentDrag,
            action: .targetDetected(.fixture, attemptID: .attemptA)
        )

        #expect(transition.state == currentDrag)
        #expect(transition.effects.isEmpty)
    }

    @Test("stale rejection cannot mutate idle, retracting, or a new drag")
    func staleTargetRejectionIsIgnored() {
        let failure = VoiceVACFailure(code: .noPlayableMedia, message: "Stale")
        let idle = VoiceVACState.idle
        let retracting = VoiceVACState(
            phase: .retracting,
            nozzleGlobalPoint: CGPoint(x: 100, y: 200),
            attemptID: .attemptA
        )
        let newDrag = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(at: CGPoint(x: 300, y: 400), attemptID: .attemptB)
        ).state

        for state in [idle, retracting, newDrag] {
            let transition = VoiceVACReducer.reduce(
                state: state,
                action: .targetRejected(failure, attemptID: .attemptA)
            )
            #expect(transition.state == state)
            #expect(transition.effects.isEmpty)
        }
    }

    @Test("old rejection cannot prevent current retraction completion")
    func staleRejectionDoesNotBreakRetractionCompletion() {
        let retracting = VoiceVACState(
            phase: .retracting,
            nozzleGlobalPoint: CGPoint(x: 100, y: 200),
            attemptID: .attemptB
        )
        let failure = VoiceVACFailure(code: .noPlayableMedia, message: "Stale")

        let afterRejection = VoiceVACReducer.reduce(
            state: retracting,
            action: .targetRejected(failure, attemptID: .attemptA)
        )
        #expect(afterRejection.state == retracting)

        let completed = VoiceVACReducer.reduce(
            state: afterRejection.state,
            action: .retractionCompleted
        )
        #expect(completed.state == .idle)
        #expect(completed.effects.isEmpty)
    }

    @Test("primary button pauses and resumes an active capture")
    func primaryButtonTogglesCapture() {
        let target = VideoTarget.fixture
        let transcribing = VoiceVACState(
            phase: .transcribing,
            target: target,
            attemptID: .attemptA
        )

        let paused = VoiceVACReducer.reduce(
            state: transcribing,
            action: .primaryButtonPressed
        )
        #expect(paused.state.phase == .paused)
        #expect(paused.effects == [.pauseCapture])

        let resumed = VoiceVACReducer.reduce(
            state: paused.state,
            action: .primaryButtonPressed
        )
        #expect(resumed.state.phase == .transcribing)
        #expect(resumed.effects == [.resumeCapture])
    }

    @Test("drag actions deploy and move the nozzle")
    func dragActionsMoveNozzle() {
        let began = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(
                at: CGPoint(x: -220, y: 480),
                attemptID: .attemptA
            )
        )
        #expect(began.state.phase == .dragging)
        #expect(began.state.nozzleGlobalPoint == CGPoint(x: -220, y: 480))
        #expect(began.state.attemptID == .attemptA)

        let moved = VoiceVACReducer.reduce(
            state: began.state,
            action: .moveNozzle(to: CGPoint(x: 120, y: 320))
        )
        #expect(moved.state.phase == .dragging)
        #expect(moved.state.nozzleGlobalPoint == CGPoint(x: 120, y: 320))
    }

    @Test("a tab-audio target must be detected and resolved before capture")
    func tabAudioTargetRequiresReadiness() {
        let tabAudioTarget = VideoTarget.fixture(kind: .tabAudio, canDirectPlay: false)
        let dragging = VoiceVACReducer.reduce(
            state: .idle,
            action: .beginNozzleDrag(
                at: CGPoint(x: 240, y: 180),
                attemptID: .attemptA
            )
        )

        let detected = VoiceVACReducer.reduce(
            state: dragging.state,
            action: .targetDetected(tabAudioTarget, attemptID: .attemptA)
        )
        #expect(detected.state.phase == .tabAudioOnly)
        #expect(detected.state.target == tabAudioTarget)
        #expect(detected.effects.isEmpty)

        let prematurePress = VoiceVACReducer.reduce(
            state: detected.state,
            action: .primaryButtonPressed
        )
        #expect(prematurePress.state.phase == .tabAudioOnly)
        #expect(prematurePress.effects.isEmpty)

        let ready = VoiceVACReducer.reduce(
            state: prematurePress.state,
            action: .targetResolved(tabAudioTarget, attemptID: .attemptA)
        )
        #expect(ready.state.phase == .ready)
        #expect(ready.state.target == tabAudioTarget)
        #expect(ready.effects.isEmpty)

        let started = VoiceVACReducer.reduce(
            state: ready.state,
            action: .primaryButtonPressed
        )
        #expect(started.state.phase == .transcribing)
        #expect(started.effects == [.startCapture(tabAudioTarget)])
    }

    @Test("transcript completion and retraction update lifecycle state")
    func lifecycleActionsUpdateState() {
        let target = VideoTarget.fixture
        let capturing = VoiceVACState(
            phase: .transcribing,
            nozzleGlobalPoint: CGPoint(x: 400, y: 300),
            target: target,
            attemptID: .attemptA
        )

        let previewed = VoiceVACReducer.reduce(
            state: capturing,
            action: .transcriptPreviewChanged("A live preview")
        )
        #expect(previewed.state.transcriptPreview == "A live preview")

        let completed = VoiceVACReducer.reduce(
            state: previewed.state,
            action: .captureCompleted
        )
        #expect(completed.state.phase == .completed)
        #expect(completed.effects.isEmpty)

        let retracting = VoiceVACReducer.reduce(
            state: completed.state,
            action: .retractRequested
        )
        #expect(retracting.state.phase == .retracting)
        #expect(retracting.effects == [.stopAndFlush, .beginRetraction])

        let idle = VoiceVACReducer.reduce(
            state: retracting.state,
            action: .retractionCompleted
        )
        #expect(idle.state == .idle)
        #expect(idle.effects.isEmpty)
    }

    @Test(
        "capture completion only terminates an active or paused capture",
        arguments: VoiceVACPhase.everyCase
    )
    func captureCompletionIsPhaseGuarded(phase: VoiceVACPhase) {
        let state = VoiceVACState(
            phase: phase,
            nozzleGlobalPoint: CGPoint(x: 400, y: 300),
            target: .fixture,
            transcriptPreview: "new session",
            attemptID: .attemptA
        )

        let transition = VoiceVACReducer.reduce(
            state: state,
            action: .captureCompleted
        )

        if phase == .transcribing || phase == .paused {
            #expect(transition.state.phase == .completed)
            #expect(transition.state.target == state.target)
        } else {
            #expect(transition.state == state)
        }
        #expect(transition.effects.isEmpty)
    }

    @Test(
        "retraction completion only clears a currently retracting session",
        arguments: VoiceVACPhase.everyCase
    )
    func retractionCompletionIsPhaseGuarded(phase: VoiceVACPhase) {
        let state = VoiceVACState(
            phase: phase,
            nozzleGlobalPoint: CGPoint(x: 400, y: 300),
            target: .fixture,
            transcriptPreview: "new session",
            attemptID: .attemptA
        )

        let transition = VoiceVACReducer.reduce(
            state: state,
            action: .retractionCompleted
        )

        if phase == .retracting {
            #expect(transition.state == .idle)
        } else {
            #expect(transition.state == state)
        }
        #expect(transition.effects.isEmpty)
    }

    @Test("non-retraction actions never stop and retract")
    func onlyRetractRequestProducesRetractionEffects() {
        let target = VideoTarget.fixture
        let failure = VoiceVACFailure(code: .captureDenied, message: "Denied")
        let actions: [VoiceVACAction] = [
            .beginNozzleDrag(at: .zero, attemptID: .attemptA),
            .moveNozzle(to: CGPoint(x: 1, y: 2)),
            .targetDetected(target, attemptID: .attemptA),
            .targetResolved(target, attemptID: .attemptA),
            .targetRejected(failure, attemptID: .attemptA),
            .primaryButtonPressed,
            .transcriptPreviewChanged("preview"),
            .captureCompleted,
            .retractionCompleted
        ]

        for action in actions {
            let effects = VoiceVACReducer.reduce(state: .idle, action: action).effects
            #expect(!effects.contains(.stopAndFlush))
            #expect(!effects.contains(.beginRetraction))
        }
    }
}

private extension VideoTarget {
    static let fixture = fixture()

    static func fixture(
        id: String = "target-A",
        kind: Kind = .htmlMedia,
        frameID: Int = 0,
        documentID: String = "document-A",
        canDirectPlay: Bool = true
    ) -> VideoTarget {
        VideoTarget(
            id: id,
            kind: kind,
            tag: kind == .htmlMedia ? .video : nil,
            frameID: frameID,
            documentID: documentID,
            viewportRect: CGRect(x: 100, y: 120, width: 640, height: 360),
            screenRect: CGRect(x: 300, y: 220, width: 640, height: 360),
            activationPoint: CGPoint(x: 420, y: 280),
            canDirectPlay: canDirectPlay
        )
    }
}

private extension UUID {
    static let attemptA = UUID(uuidString: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")!
    static let attemptB = UUID(uuidString: "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB")!
}

private extension VoiceVACPhase {
    static let everyCase: [VoiceVACPhase] = [
        .idle,
        .dragging,
        .targetDetected,
        .tabAudioOnly,
        .ready,
        .transcribing,
        .paused,
        .completed,
        .retracting,
        .warningYellow
    ]
}
