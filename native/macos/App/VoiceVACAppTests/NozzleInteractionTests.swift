import AppKit
import simd
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class NozzleInteractionTests: XCTestCase {
    func testPasteboardContainsOnlyAuthenticatedTokenAndNeverAURL() throws {
        let sessionID = UUID(uuidString: "2B0FE529-4021-4674-B55E-1CF081F947DD")!
        let nonce = Data(0..<32)

        let item = try NozzlePasteboard.makePasteboardItem(sessionID: sessionID, nonce: nonce)
        let token = try XCTUnwrap(item.string(forType: .string))

        XCTAssertEqual(item.types, [.string])
        XCTAssertEqual(
            token,
            "VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        )
        XCTAssertFalse(token.localizedCaseInsensitiveContains("http"))
        XCTAssertEqual(try NozzlePasteboard.parse(token).sessionID, sessionID)
    }

    func testDragItemIsBackedByNativePasteboardItemAndStringTokenOnly() throws {
        let coordinator = NozzleDragCoordinator(
            store: VoiceVACStore(),
            hoseSession: nil,
            dockPoint: CGPoint(x: 20, y: 30)
        )
        let item = try coordinator.makeDraggingItem(
            sessionID: UUID(uuidString: "2B0FE529-4021-4674-B55E-1CF081F947DD")!,
            nonce: Data(repeating: 7, count: 32),
            frame: CGRect(x: 0, y: 0, width: 72, height: 34)
        )

        let writer = try XCTUnwrap(item.item as? NSPasteboardItem)
        XCTAssertEqual(writer.types, [.string])
        XCTAssertTrue(try XCTUnwrap(writer.string(forType: .string)).hasPrefix("VOICE_VAC_DROP_V1|"))
        let _: any NSDraggingSource = coordinator
    }

    func testNozzleRotatesFromVerticalDockToHorizontalDrag() {
        XCTAssertEqual(NozzleDragCoordinator.mouthRotation(dragProgress: 0), 0, accuracy: 0.0001)
        XCTAssertEqual(NozzleDragCoordinator.mouthRotation(dragProgress: 0.5), .pi / 4, accuracy: 0.0001)
        XCTAssertEqual(NozzleDragCoordinator.mouthRotation(dragProgress: 1), .pi / 2, accuracy: 0.0001)
    }

    func testDoubleClickTimelineIsDeterministicAndUsesFourOrderedStages() {
        let animator = NozzleURLAnimator()
        XCTAssertEqual(animator.timeline.map(\.stage), [
            .unlockAndLift,
            .rotateInPlane,
            .cExtension,
            .reverseSCurlAndInput,
        ])

        let firstPass = stride(from: 0.0, through: animator.duration, by: 0.025).map(animator.frame(at:))
        let secondPass = stride(from: 0.0, through: animator.duration, by: 0.025).map(animator.frame(at:))
        XCTAssertEqual(firstPass, secondPass)
        XCTAssertEqual(animator.frame(at: 0).stage, .unlockAndLift)
        XCTAssertEqual(animator.frame(at: animator.duration).stage, .reverseSCurlAndInput)
        XCTAssertEqual(animator.frame(at: animator.duration).mouthRotation, .pi / 2, accuracy: 0.0001)
        XCTAssertTrue(animator.frame(at: animator.duration).showsURLInput)
    }

    func testURLInputOnlyBecomesKeyWhilePresentedAndAcceptsReturnAndStart() throws {
        var submissions: [URL] = []
        let input = NozzleURLInputView { submissions.append($0) }
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 320, height: 56), styleMask: .borderless, backing: .buffered, defer: false)
        window.contentView = input

        XCTAssertTrue(input.isHidden)
        XCTAssertFalse(input.urlField.acceptsFirstResponder)

        input.setPresented(true)
        XCTAssertFalse(input.isHidden)
        XCTAssertTrue(input.urlField.acceptsFirstResponder)
        XCTAssertTrue(window.makeFirstResponder(input.urlField))

        input.urlField.stringValue = "https://example.com/video"
        XCTAssertTrue(input.control(input.urlField, textView: NSTextView(), doCommandBy: #selector(NSResponder.insertNewline(_:))))
        input.urlField.stringValue = "https://example.org/second"
        input.startButton.performClick(nil)

        XCTAssertEqual(submissions, [
            URL(string: "https://example.com/video")!,
            URL(string: "https://example.org/second")!,
        ])
        input.setPresented(false)
        XCTAssertFalse(input.urlField.acceptsFirstResponder)
    }

    func testWarningYellowDoesNotRetractUntilXOrANewDrag() async throws {
        let attemptID = UUID()
        let store = VoiceVACStore()
        store.send(.beginNozzleDrag(at: CGPoint(x: 10, y: 10), attemptID: attemptID))
        store.send(.targetRejected(
            VoiceVACFailure(code: .noPlayableMedia, message: "No playable media"),
            attemptID: attemptID
        ))
        let controller = NozzleRetractionController(
            store: store,
            hoseSession: nil,
            dockPoint: .zero
        )

        _ = try await controller.advance(deltaTime: 5)

        XCTAssertEqual(store.state.phase, .warningYellow)
        XCTAssertEqual(store.state.nozzleGlobalPoint, CGPoint(x: 10, y: 10))

        try await controller.requestRetraction()
        XCTAssertEqual(store.state.phase, .retracting)
    }

    func testCapturingStopsAndFlushesBeforeRetractionCanShorten() async throws {
        let store = VoiceVACStore(state: VoiceVACState(
            phase: .transcribing,
            nozzleGlobalPoint: CGPoint(x: 240, y: 20)
        ))
        var effects: [VoiceVACEffect] = []
        let controller = NozzleRetractionController(
            store: store,
            hoseSession: nil,
            dockPoint: CGPoint(x: 20, y: 20),
            effectHandler: { effect in effects.append(effect) }
        )

        try await controller.requestRetraction(from: NozzleRetractionPose(
            nozzlePoint: CGPoint(x: 240, y: 20),
            hoseTangent: CGVector(dx: 1, dy: 0),
            activeLength: 260,
            mouthRotation: .pi / 2
        ))

        XCTAssertEqual(effects, [.stopAndFlush, .beginRetraction])
        XCTAssertTrue(controller.isRetracting)
        XCTAssertEqual(controller.currentFrame?.activeLength, 260)
    }

    func testRetractionLengthIsMonotonicAndOnlyCompletesDockedVertically() async throws {
        let store = VoiceVACStore(state: VoiceVACState(
            phase: .ready,
            nozzleGlobalPoint: CGPoint(x: 220, y: 40)
        ))
        let controller = NozzleRetractionController(
            store: store,
            hoseSession: nil,
            dockPoint: CGPoint(x: 20, y: 40),
            minimumActiveLength: 32,
            retractionSpeed: 520
        )
        try await controller.requestRetraction(from: NozzleRetractionPose(
            nozzlePoint: CGPoint(x: 220, y: 40),
            hoseTangent: CGVector(dx: 1, dy: 0),
            activeLength: 260,
            mouthRotation: .pi / 2
        ))

        var frames: [NozzleRetractionFrame] = []
        while store.state.phase == .retracting {
            if let frame = try await controller.advance(deltaTime: 1.0 / 60.0) {
                frames.append(frame)
            }
        }

        XCTAssertGreaterThan(frames.count, 2)
        XCTAssertTrue(zip(frames, frames.dropFirst()).allSatisfy { $1.activeLength <= $0.activeLength })
        let final = try XCTUnwrap(frames.last)
        XCTAssertEqual(final.nozzlePoint.x, 20, accuracy: 0.001)
        XCTAssertEqual(final.nozzlePoint.y, 40, accuracy: 0.001)
        XCTAssertEqual(final.activeLength, 32, accuracy: 0.001)
        XCTAssertEqual(final.mouthRotation, 0, accuracy: 0.001)
        XCTAssertEqual(store.state.phase, .idle)
    }

    func testCloseButtonFollowsHoseTangentFortyPointsAboveNozzle() {
        let nozzle = CGPoint(x: 200, y: 100)
        let close = NozzleRetractionController.closeButtonPoint(
            nozzlePoint: nozzle,
            hoseTangent: CGVector(dx: 3, dy: 4)
        )

        XCTAssertEqual(hypot(close.x - nozzle.x, close.y - nozzle.y), 40, accuracy: 0.001)
        XCTAssertEqual(close.x, 176, accuracy: 0.001)
        XCTAssertEqual(close.y, 68, accuracy: 0.001)
    }

    func testPhysicalButtonDrivesTheRealUSDZButtonCapThroughNamedTransforms() async throws {
        let target = makeTarget()
        let store = VoiceVACStore(state: VoiceVACState(phase: .ready, target: target))
        let device = VoiceVACDeviceInteractionController()
        _ = try await device.loadMainDevice()
        let button = PhysicalButtonView(store: store, deviceController: device)
        let buttonCap = try XCTUnwrap(device.buttonCapEntity)
        let readyTransform = buttonCap.transform

        XCTAssertEqual(button.performPrimaryAction(), [.startCapture(target)])
        XCTAssertEqual(store.state.phase, .transcribing)
        let downTransform = buttonCap.transform
        XCTAssertNotEqual(downTransform, readyTransform)
        XCTAssertEqual(
            downTransform.translation.y - device.transform(for: .buttonUp).translation.y,
            0.009,
            accuracy: 0.000_001
        )

        XCTAssertEqual(button.performPrimaryAction(), [.pauseCapture])
        XCTAssertEqual(store.state.phase, .paused)
        let pausedTransform = buttonCap.transform
        XCTAssertNotEqual(pausedTransform, downTransform)

        XCTAssertEqual(button.performPrimaryAction(), [.resumeCapture])
        XCTAssertEqual(store.state.phase, .transcribing)
        XCTAssertEqual(buttonCap.transform, downTransform)
        XCTAssertFalse(button.isOpaque)
        XCTAssertEqual(button.frame.size, CGSize(width: 96, height: 96))
    }

    private func makeTarget() -> VideoTarget {
        VideoTarget(
            id: "target",
            kind: .htmlMedia,
            tag: .video,
            frameID: 0,
            documentID: "document",
            viewportRect: CGRect(x: 10, y: 10, width: 640, height: 360),
            screenRect: CGRect(x: 100, y: 100, width: 640, height: 360),
            activationPoint: CGPoint(x: 320, y: 180),
            canDirectPlay: true
        )
    }
}
