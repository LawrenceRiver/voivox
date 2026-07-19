import CoreGraphics
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC state transitions")
struct VoiceVACReducerTests {
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
        #expect(transition.state.failure == failure)
        #expect(!transition.effects.contains(.beginRetraction))
    }

    @Test("ready requires a physical primary press before capture")
    func readyGatesCapture() {
        let target = VideoTarget.fixture
        let readyTransition = VoiceVACReducer.reduce(
            state: .idle,
            action: .targetResolved(target)
        )
        #expect(readyTransition.state.phase == .ready)
        #expect(readyTransition.state.target == target)
        #expect(readyTransition.effects.isEmpty)

        let started = VoiceVACReducer.reduce(
            state: readyTransition.state,
            action: .primaryButtonPressed
        )
        #expect(started.state.phase == .transcribing)
        #expect(started.effects == [.startCapture(target)])
    }

    @Test("primary button pauses and resumes an active capture")
    func primaryButtonTogglesCapture() {
        let target = VideoTarget.fixture
        let transcribing = VoiceVACState(
            phase: .transcribing,
            target: target
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
            action: .beginNozzleDrag(at: CGPoint(x: -220, y: 480))
        )
        #expect(began.state.phase == .dragging)
        #expect(began.state.nozzleGlobalPoint == CGPoint(x: -220, y: 480))

        let moved = VoiceVACReducer.reduce(
            state: began.state,
            action: .moveNozzle(to: CGPoint(x: 120, y: 320))
        )
        #expect(moved.state.phase == .dragging)
        #expect(moved.state.nozzleGlobalPoint == CGPoint(x: 120, y: 320))
    }

    @Test("tab audio targets remain explicitly identified")
    func tabAudioTargetUsesDedicatedPhase() {
        let tabAudioTarget = VideoTarget.fixture(kind: .tabAudio, canDirectPlay: false)

        let transition = VoiceVACReducer.reduce(
            state: .idle,
            action: .targetResolved(tabAudioTarget)
        )

        #expect(transition.state.phase == .tabAudioOnly)
        #expect(transition.state.target == tabAudioTarget)
        #expect(transition.effects.isEmpty)
    }

    @Test("transcript completion and retraction update lifecycle state")
    func lifecycleActionsUpdateState() {
        let target = VideoTarget.fixture
        let capturing = VoiceVACState(
            phase: .transcribing,
            nozzleGlobalPoint: CGPoint(x: 400, y: 300),
            target: target
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

    @Test("non-retraction actions never stop and retract")
    func onlyRetractRequestProducesRetractionEffects() {
        let target = VideoTarget.fixture
        let failure = VoiceVACFailure(code: .captureDenied, message: "Denied")
        let actions: [VoiceVACAction] = [
            .beginNozzleDrag(at: .zero),
            .moveNozzle(to: CGPoint(x: 1, y: 2)),
            .targetResolved(target),
            .targetRejected(failure),
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
        kind: Kind = .htmlMedia,
        canDirectPlay: Bool = true
    ) -> VideoTarget {
        VideoTarget(
            id: "target-A",
            kind: kind,
            tag: kind == .htmlMedia ? .video : nil,
            frameID: 0,
            documentID: "document-A",
            viewportRect: CGRect(x: 100, y: 120, width: 640, height: 360),
            screenRect: CGRect(x: 300, y: 220, width: 640, height: 360),
            activationPoint: CGPoint(x: 420, y: 280),
            canDirectPlay: canDirectPlay
        )
    }
}
