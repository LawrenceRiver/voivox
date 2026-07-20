import AppKit
import RealityKit
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class ProductionInteractionIntegrationTests: XCTestCase {
    private let exactToken = "VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

    func testRealDeviceSeparatesTheNozzleCloneAndHidesTheMainCopy() async throws {
        let device = VoiceVACDeviceInteractionController()
        let main = try await device.loadMainDevice()
        let embeddedNozzle = try XCTUnwrap(main.findEntity(named: "VAC_NOZZLE"))
        let nozzleClone = try await device.loadNozzleClone()

        XCTAssertFalse(embeddedNozzle.isEnabled)
        XCTAssertTrue(nozzleClone.isEnabled)
        XCTAssertEqual(nozzleClone.name, "VAC_NOZZLE")
        XCTAssertFalse(nozzleClone === embeddedNozzle)
        XCTAssertNotNil(nozzleClone.findEntity(named: "VAC_NOZZLE_TIP"))
    }

    func testNamedButtonPosesMutateTheLoadedEntityAndReadyLight() async throws {
        let device = VoiceVACDeviceInteractionController()
        _ = try await device.loadMainDevice()
        let cap = try XCTUnwrap(device.buttonCapEntity)

        try device.applyButtonPose(.buttonUp)
        let up = cap.transform
        try device.applyButtonPose(.buttonReady)
        let ready = cap.transform
        XCTAssertNotEqual(ready, up)
        XCTAssertTrue(device.readyLightEntity?.isEnabled ?? false)

        try device.applyButtonPose(.buttonDown)
        let down = cap.transform
        XCTAssertEqual(down.translation.y - up.translation.y, 0.009, accuracy: 0.000_001)
        XCTAssertFalse(device.readyLightEntity?.isEnabled ?? true)

        try device.applyButtonPose(.buttonPaused)
        XCTAssertNotEqual(cap.transform, down)
    }

    func testDragProgressInterpolatesTheActualNozzleEntityTransform() async throws {
        let device = VoiceVACDeviceInteractionController()
        let nozzle = try await device.loadNozzleClone()

        try device.applyNozzleDragProgress(0)
        let docked = nozzle.transform
        try device.applyNozzleDragProgress(0.5)
        let halfway = nozzle.transform
        try device.applyNozzleDragProgress(1)
        let deployed = nozzle.transform

        XCTAssertNotEqual(halfway, docked)
        XCTAssertNotEqual(halfway, deployed)
        let expected = device.transform(for: .nozzleDeployed)
        XCTAssertEqual(deployed.translation.x, expected.translation.x, accuracy: 0.000001)
        XCTAssertEqual(deployed.translation.y, expected.translation.y, accuracy: 0.000001)
        XCTAssertEqual(deployed.translation.z, expected.translation.z, accuracy: 0.000001)
        XCTAssertEqual(deployed.rotation.real, expected.rotation.real, accuracy: 0.000001)
        XCTAssertEqual(deployed.rotation.imag.x, expected.rotation.imag.x, accuracy: 0.000001)
        XCTAssertEqual(deployed.rotation.imag.y, expected.rotation.imag.y, accuracy: 0.000001)
        XCTAssertEqual(deployed.rotation.imag.z, expected.rotation.imag.z, accuracy: 0.000001)
    }

    func testLiveFactoryWiresOneSharedStoreRuntimeAndRealPanels() throws {
        let screen = ScreenDescriptor(
            id: ScreenID(rawValue: 77),
            frame: CGRect(x: 0, y: 0, width: 1512, height: 982),
            visibleFrame: CGRect(x: 0, y: 40, width: 1512, height: 942),
            backingScaleFactor: 2
        )
        let screens = ProductionFakeScreenProvider(screen: screen)
        let tokenProvider = ExactTokenProvider(token: exactToken)
        let defaults = UserDefaults(suiteName: "VoiceVAC.ProductionInteractionIntegrationTests.\(UUID().uuidString)")!
        let environment = LiveAppEnvironmentFactory(
            screenProvider: screens,
            placementDefaults: defaults,
            sessionTokenProvider: tokenProvider
        ).makeEnvironment()

        environment.start()

        let coordinator = try XCTUnwrap(environment.windowCoordinator as? OverlayCoordinator)
        let runtime = try XCTUnwrap(coordinator.interactionRuntime)
        XCTAssertTrue(runtime.store === environment.store)
        XCTAssertTrue(runtime.sessionTokenProvider === tokenProvider)
        XCTAssertTrue(coordinator.panel(for: .capsule) is CapsulePanel)
        XCTAssertTrue(coordinator.panel(for: .nozzle) is NozzleHitPanel)
        XCTAssertTrue(coordinator.panel(for: .transcript) is TranscriptPanel)
        XCTAssertTrue(coordinator.panel(for: .urlInput) is URLInputPanel)

        let capsule = try XCTUnwrap(coordinator.panel(for: .capsule) as? CapsulePanel)
        XCTAssertTrue(capsule.glass.physicalButton.store === environment.store)
        XCTAssertTrue(capsule.glass.physicalButton.deviceController === runtime.deviceController)
        XCTAssertEqual(capsule.glass.physicalButton.accessibilityIdentifier(), "voice-vac-physical-button")
    }

    func testMissingArmedChromeSessionShowsEnglishWarningAndCreatesNoFakeToken() {
        let store = VoiceVACStore()
        let runtime = VoiceVACInteractionRuntime(
            store: store,
            hoseSession: nil,
            deviceController: VoiceVACDeviceInteractionController(),
            sessionTokenProvider: UnavailableCrossWindowSessionTokenProvider()
        )

        XCTAssertThrowsError(try runtime.requireArmedDragToken()) { error in
            XCTAssertEqual(error as? VoiceVACInteractionError, .chromeSessionNotArmed)
        }
        XCTAssertEqual(store.state.phase, .warningYellow)
        XCTAssertEqual(store.state.failure?.message, "Arm a Chrome video first")
        XCTAssertNil(store.state.attemptID)
    }

    func testInjectedArmedSessionProvidesTheExactChromeToken() throws {
        let provider = ExactTokenProvider(token: exactToken)
        let runtime = VoiceVACInteractionRuntime(
            store: VoiceVACStore(),
            hoseSession: nil,
            deviceController: VoiceVACDeviceInteractionController(),
            sessionTokenProvider: provider
        )

        let token = try runtime.requireArmedDragToken()

        XCTAssertEqual(token.encoded, exactToken)
        XCTAssertEqual(token.sessionID, UUID(uuidString: "2B0FE529-4021-4674-B55E-1CF081F947DD"))
        XCTAssertEqual(token.nonce, Data(repeating: 0, count: 32))
    }

    func testAuxiliaryPanelsInstallLiveContentAndAccessibilityIdentifiers() {
        let store = VoiceVACStore(state: VoiceVACState(
            phase: .transcribing,
            transcriptPreview: "Only this transcript is copied."
        ))
        let transcript = TranscriptPanel(frame: CGRect(x: 0, y: 0, width: 318, height: 74), store: store)
        let url = URLInputPanel(frame: CGRect(x: 0, y: 0, width: 318, height: 74), onSubmit: { _ in })

        XCTAssertEqual(transcript.glass.titleLabel.stringValue, "Voice VAC")
        XCTAssertEqual(transcript.glass.previewLabel.stringValue, "Only this transcript is copied.")
        XCTAssertEqual(transcript.glass.copyButton.accessibilityIdentifier(), "voice-vac-copy-transcript")
        XCTAssertTrue(url.inputView.isDescendant(of: try! XCTUnwrap(url.contentView)))
        XCTAssertEqual(url.inputView.urlField.accessibilityIdentifier(), "voice-vac-url-field")
        XCTAssertEqual(url.inputView.startButton.accessibilityIdentifier(), "voice-vac-url-start")

        NSPasteboard.general.clearContents()
        transcript.glass.copyButton.performClick(nil)
        XCTAssertEqual(
            NSPasteboard.general.string(forType: .string),
            "Only this transcript is copied."
        )
    }

    func testDoubleClickRuntimeTimelineMovesRealNozzleThenPresentsURLInput() async throws {
        let device = VoiceVACDeviceInteractionController()
        let nozzle = try await device.loadNozzleClone()
        let initial = nozzle.transform
        let clock = ManualVoiceVACFrameClock()
        let presenter = InteractionPresenterSpy()
        let runtime = VoiceVACInteractionRuntime(
            store: VoiceVACStore(),
            hoseSession: nil,
            deviceController: device,
            sessionTokenProvider: UnavailableCrossWindowSessionTokenProvider(),
            frameClock: clock,
            dockPoint: CGPoint(x: 200, y: 200)
        )
        runtime.presenter = presenter

        runtime.beginURLInputAnimation()
        clock.advance(by: NozzleURLAnimator().duration)

        XCTAssertNotEqual(nozzle.transform, initial)
        XCTAssertEqual(presenter.urlPresentationEvents, [false, true])
        XCTAssertEqual(try XCTUnwrap(presenter.nozzleMoves.last).center.x, 386, accuracy: 0.001)
        XCTAssertFalse(clock.isRunning)
    }

    func testProductionClockIsSixtyHertzAndRetractionDriverConsumesTicks() async throws {
        let store = VoiceVACStore(state: VoiceVACState(
            phase: .ready,
            nozzleGlobalPoint: CGPoint(x: 240, y: 40)
        ))
        let clock = ManualVoiceVACFrameClock()
        let runtime = VoiceVACInteractionRuntime(
            store: store,
            hoseSession: nil,
            deviceController: VoiceVACDeviceInteractionController(),
            sessionTokenProvider: UnavailableCrossWindowSessionTokenProvider(),
            frameClock: clock,
            dockPoint: CGPoint(x: 20, y: 40)
        )

        XCTAssertEqual(VoiceVACDisplayTimerClock.framesPerSecond, 60)
        try await runtime.requestRetraction()
        XCTAssertTrue(clock.isRunning)

        for _ in 0..<180 where store.state.phase == .retracting {
            clock.advance(by: 1.0 / 60.0)
            await Task.yield()
        }
        XCTAssertEqual(store.state.phase, .idle)
    }
}

@MainActor
private final class ProductionFakeScreenProvider: ScreenProviding {
    var screens: [ScreenDescriptor]
    var preferredScreenID: ScreenID?
    var onScreensChanged: (() -> Void)?

    init(screen: ScreenDescriptor) {
        screens = [screen]
        preferredScreenID = screen.id
    }
}

@MainActor
private final class ExactTokenProvider: CrossWindowSessionTokenProviding {
    let token: String
    init(token: String) { self.token = token }
    func currentArmedDropToken() -> String? { token }
}

@MainActor
private final class ManualVoiceVACFrameClock: VoiceVACFrameClock {
    private var tick: ((TimeInterval) -> Void)?
    private(set) var isRunning = false

    func start(_ tick: @escaping (TimeInterval) -> Void) {
        self.tick = tick
        isRunning = true
    }

    func stop() {
        tick = nil
        isRunning = false
    }

    func advance(by deltaTime: TimeInterval) {
        tick?(deltaTime)
    }
}

@MainActor
private final class InteractionPresenterSpy: VoiceVACInteractionPresenting {
    struct Move {
        let center: CGPoint
        let tangent: CGVector
        let showsCloseButton: Bool
    }

    private(set) var nozzleMoves: [Move] = []
    private(set) var dockCallCount = 0
    private(set) var urlPresentationEvents: [Bool] = []

    func moveNozzlePanel(center: CGPoint, hoseTangent: CGVector, showsCloseButton: Bool) {
        nozzleMoves.append(Move(
            center: center,
            tangent: hoseTangent,
            showsCloseButton: showsCloseButton
        ))
    }

    func dockNozzlePanel() {
        dockCallCount += 1
    }

    func setURLInputPresented(_ isPresented: Bool) {
        urlPresentationEvents.append(isPresented)
    }
}
