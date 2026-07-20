import AppKit
import Foundation
import simd
import VoiceVACCore

@MainActor
protocol CrossWindowSessionTokenProviding: AnyObject {
    func currentArmedDropToken() -> String?
}

@MainActor
final class UnavailableCrossWindowSessionTokenProvider: CrossWindowSessionTokenProviding {
    func currentArmedDropToken() -> String? { nil }
}

enum VoiceVACInteractionError: Error, Equatable, LocalizedError {
    case chromeSessionNotArmed
    case invalidChromeDropToken

    var errorDescription: String? {
        switch self {
        case .chromeSessionNotArmed:
            "Arm a Chrome video first"
        case .invalidChromeDropToken:
            "The armed Chrome session is invalid"
        }
    }
}

@MainActor
protocol VoiceVACFrameClock: AnyObject {
    func start(_ tick: @escaping (TimeInterval) -> Void)
    func stop()
}

@MainActor
final class VoiceVACDisplayTimerClock: VoiceVACFrameClock {
    static let framesPerSecond = 60
    private var timer: Timer?
    private var previousUptime: TimeInterval?
    private var tickHandler: ((TimeInterval) -> Void)?

    func start(_ tick: @escaping (TimeInterval) -> Void) {
        stop()
        tickHandler = tick
        previousUptime = ProcessInfo.processInfo.systemUptime
        let timer = Timer(
            timeInterval: 1.0 / Double(Self.framesPerSecond),
            target: self,
            selector: #selector(frameTimerFired(_:)),
            userInfo: nil,
            repeats: true
        )
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        previousUptime = nil
        tickHandler = nil
    }

    @objc private func frameTimerFired(_ timer: Timer) {
        let now = ProcessInfo.processInfo.systemUptime
        let delta = max(now - (previousUptime ?? now), 0)
        previousUptime = now
        tickHandler?(delta)
    }
}

@MainActor
protocol VoiceVACInteractionPresenting: AnyObject {
    func moveNozzlePanel(center: CGPoint, hoseTangent: CGVector, showsCloseButton: Bool)
    func dockNozzlePanel()
    func setURLInputPresented(_ isPresented: Bool)
}

/// The retained production interaction graph. Panels are intentionally dumb surfaces;
/// this object is the one path from native input to store, hose simulation and USDZ poses.
@MainActor
final class VoiceVACInteractionRuntime {
    typealias EffectHandler = @MainActor (VoiceVACEffect) async throws -> Void

    let store: VoiceVACStore
    let deviceController: VoiceVACDeviceInteractionController
    let sessionTokenProvider: any CrossWindowSessionTokenProviding
    let frameClock: any VoiceVACFrameClock

    weak var presenter: (any VoiceVACInteractionPresenting)?
    private let hoseSession: HoseRenderSession?
    private let effectHandler: EffectHandler
    private let urlAnimator = NozzleURLAnimator()
    private var urlElapsed: TimeInterval = 0
    private var dockPoint: CGPoint
    private var dragCoordinator: NozzleDragCoordinator?
    private var retractionController: NozzleRetractionController

    init(
        store: VoiceVACStore,
        hoseSession: HoseRenderSession?,
        deviceController: VoiceVACDeviceInteractionController,
        sessionTokenProvider: any CrossWindowSessionTokenProviding,
        frameClock: any VoiceVACFrameClock = VoiceVACDisplayTimerClock(),
        dockPoint: CGPoint = .zero,
        effectHandler: @escaping EffectHandler = { _ in }
    ) {
        self.store = store
        self.hoseSession = hoseSession
        self.deviceController = deviceController
        self.sessionTokenProvider = sessionTokenProvider
        self.frameClock = frameClock
        self.dockPoint = dockPoint
        self.effectHandler = effectHandler
        self.retractionController = NozzleRetractionController(
            store: store,
            hoseSession: hoseSession,
            dockPoint: dockPoint,
            effectHandler: effectHandler
        )
    }

    func configureDock(frame: CGRect) {
        dockPoint = CGPoint(x: frame.midX, y: frame.midY)
        guard !retractionController.isRetracting else { return }
        retractionController = makeRetractionController()
    }

    func requireArmedDragToken() throws -> NozzleDragToken {
        guard let encoded = sessionTokenProvider.currentArmedDropToken() else {
            reportInteractionFailure(.chromeSessionNotArmed)
            throw VoiceVACInteractionError.chromeSessionNotArmed
        }
        do {
            return try NozzlePasteboard.parse(encoded)
        } catch {
            reportInteractionFailure(.invalidChromeDropToken)
            throw VoiceVACInteractionError.invalidChromeDropToken
        }
    }

    /// Start the visible machine response before macOS begins a pasteboard drag
    /// or Chrome confirms an armed tab. This keeps the hose under the user's
    /// hand even when the eventual target becomes a yellow warning.
    func prepareVisualDeployment(at point: CGPoint) {
        frameClock.stop()
        let distance = hypot(point.x - dockPoint.x, point.y - dockPoint.y)
        let tangent = distance > 0
            ? CGVector(
                dx: (point.x - dockPoint.x) / distance,
                dy: (point.y - dockPoint.y) / distance
            )
            : CGVector(dx: 0, dy: 1)
        try? hoseSession?.deployVisual(
            toward: NozzlePresentationKinematics.rearCylinderPoint(
                forNozzleCenter: point,
                hoseTangent: tangent
            ),
            orientation: simd_quatd(
                angle: Double(NozzlePresentationKinematics.screenRotation(forHoseTangent: tangent)),
                axis: SIMD3(0, 0, 1)
            )
        )
        try? deviceController.applyNozzleDragProgress(
            min(max(distance / 120, 0), 1),
            hoseTangent: tangent
        )
        presenter?.moveNozzlePanel(
            center: point,
            hoseTangent: tangent,
            showsCloseButton: true
        )
    }

    @discardableResult
    func beginNozzleDrag(
        from hostView: NSView,
        event: NSEvent,
        nozzleFrame: CGRect
    ) throws -> NSDraggingSession {
        let token = try requireArmedDragToken()
        frameClock.stop()
        let coordinator = NozzleDragCoordinator(
            store: store,
            hoseSession: hoseSession,
            dockPoint: dockPoint,
            deploymentHandler: { [weak self] point, progress, tangent in
                guard let self else { return }
                try? deviceController.applyNozzleDragProgress(
                    progress,
                    hoseTangent: tangent
                )
                presenter?.moveNozzlePanel(
                    center: point,
                    hoseTangent: tangent,
                    showsCloseButton: true
                )
            }
        )
        dragCoordinator = coordinator
        return try coordinator.beginDragging(
            from: hostView,
            event: event,
            token: token,
            nozzleFrame: nozzleFrame
        )
    }

    @discardableResult
    func primaryButtonPressed() -> [VoiceVACEffect] {
        let effects = store.send(.primaryButtonPressed)
        try? deviceController.synchronizeButton(for: store.state.phase)
        for effect in effects {
            Task { @MainActor [effectHandler] in
                try? await effectHandler(effect)
            }
        }
        return effects
    }

    func synchronize(with state: VoiceVACState) {
        try? deviceController.synchronizeButton(for: state.phase)
    }

    func beginURLInputAnimation() {
        frameClock.stop()
        presenter?.setURLInputPresented(false)
        urlElapsed = 0
        frameClock.start { [weak self] deltaTime in
            self?.advanceURLAnimation(deltaTime: deltaTime)
        }
    }

    func dismissURLInput() {
        frameClock.stop()
        presenter?.setURLInputPresented(false)
    }

    func submitURL(_ url: URL) {
        // The URL bridge is deliberately a callback seam for the later Chrome/native
        // bridge. It never fetches media inside the visual app process.
        dismissURLInput()
        store.reportLocalFailure(VoiceVACFailure(
            code: .tabNotArmed,
            message: "Open this link in Chrome, then arm the video"
        ))
    }

    func requestRetraction() async throws {
        frameClock.stop()
        retractionController = makeRetractionController()
        try await retractionController.requestRetraction()
        guard retractionController.isRetracting else { return }
        frameClock.start { [weak self] deltaTime in
            guard let self else { return }
            Task { @MainActor [weak self] in
                try? await self?.advanceRetraction(deltaTime: deltaTime)
            }
        }
    }

    private func advanceURLAnimation(deltaTime: TimeInterval) {
        urlElapsed = min(urlElapsed + max(deltaTime, 0), urlAnimator.duration)
        let frame = urlAnimator.frame(at: urlElapsed)
        try? deviceController.applyURLAnimationFrame(frame)
        let point = CGPoint(
            x: dockPoint.x + frame.translation.x,
            y: dockPoint.y + frame.translation.y
        )
        presenter?.moveNozzlePanel(
            center: point,
            hoseTangent: CGVector(dx: 0, dy: 1),
            showsCloseButton: true
        )
        if frame.verticalLift > 0.5 {
            try? hoseSession?.deployStraightForURL(
                toward: NozzlePresentationKinematics.rearCylinderPoint(
                    forNozzleCenter: point,
                    hoseTangent: CGVector(dx: 0, dy: 1)
                )
            )
        }
        if frame.showsEmbeddedInput {
            presenter?.setURLInputPresented(true)
        }
        if urlElapsed >= urlAnimator.duration {
            frameClock.stop()
        }
    }

    private func advanceRetraction(deltaTime: TimeInterval) async throws {
        guard let frame = try await retractionController.advance(deltaTime: deltaTime) else {
            frameClock.stop()
            return
        }
        let distance = hypot(frame.nozzlePoint.x - dockPoint.x, frame.nozzlePoint.y - dockPoint.y)
        let progress = min(max(distance / 120, 0), 1)
        try? deviceController.applyNozzleDragProgress(
            progress,
            hoseTangent: frame.hoseTangent
        )
        presenter?.moveNozzlePanel(
            center: frame.nozzlePoint,
            hoseTangent: frame.hoseTangent,
            showsCloseButton: retractionController.isRetracting
        )

        if !retractionController.isRetracting {
            frameClock.stop()
            try? deviceController.applyNozzlePose(.nozzleDocked)
            presenter?.dockNozzlePanel()
        }
    }

    private func makeRetractionController() -> NozzleRetractionController {
        NozzleRetractionController(
            store: store,
            hoseSession: hoseSession,
            dockPoint: dockPoint,
            effectHandler: effectHandler
        )
    }

    private func reportInteractionFailure(_ error: VoiceVACInteractionError) {
        store.reportLocalFailure(VoiceVACFailure(
            code: .tabNotArmed,
            message: error.errorDescription ?? "Arm a Chrome video first"
        ))
        synchronize(with: store.state)
    }
}
