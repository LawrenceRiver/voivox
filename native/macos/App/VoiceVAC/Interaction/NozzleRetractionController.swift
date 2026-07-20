import CoreGraphics
import Foundation
import simd
import VoiceVACCore

struct NozzleRetractionPose: Equatable {
    let nozzlePoint: CGPoint
    let hoseTangent: CGVector
    let activeLength: Double
    let mouthRotation: CGFloat
}

struct NozzleRetractionFrame: Equatable {
    let nozzlePoint: CGPoint
    let hoseTangent: CGVector
    let activeLength: Double
    let mouthRotation: CGFloat
    let closeButtonPoint: CGPoint
}

@MainActor
final class NozzleRetractionController {
    typealias EffectHandler = @MainActor (VoiceVACEffect) async throws -> Void

    private let store: VoiceVACStore
    private let hoseSession: HoseRenderSession?
    private let dockPoint: CGPoint
    private let minimumActiveLength: Double
    private let retractionSpeed: Double
    private let effectHandler: EffectHandler
    private var initialPose: NozzleRetractionPose?
    private var elapsed: TimeInterval = 0

    private(set) var isRetracting = false
    private(set) var currentFrame: NozzleRetractionFrame?

    init(
        store: VoiceVACStore,
        hoseSession: HoseRenderSession?,
        dockPoint: CGPoint,
        minimumActiveLength: Double? = nil,
        retractionSpeed: Double = 720,
        effectHandler: @escaping EffectHandler = { _ in }
    ) {
        self.store = store
        self.hoseSession = hoseSession
        self.dockPoint = dockPoint
        self.minimumActiveLength = minimumActiveLength
            ?? hoseSession?.stowedActiveLength
            ?? HoseConfiguration.voiceVAC.naturalSegmentLength
        self.retractionSpeed = max(retractionSpeed, 1)
        self.effectHandler = effectHandler
    }

    func requestRetraction(from providedPose: NozzleRetractionPose? = nil) async throws {
        guard !isRetracting else { return }
        let point = providedPose?.nozzlePoint ?? store.state.nozzleGlobalPoint ?? dockPoint
        let distance = Double(hypot(point.x - dockPoint.x, point.y - dockPoint.y))
        let activeLength = hoseSession?.rod.activeLength
            ?? max(minimumActiveLength, distance * 1.06)
        let pose = providedPose ?? NozzleRetractionPose(
            nozzlePoint: point,
            hoseTangent: tangent(from: dockPoint, to: point),
            activeLength: activeLength,
            mouthRotation: point == dockPoint ? 0 : .pi / 2
        )

        let effects = store.send(.retractRequested)
        for effect in effects {
            try await effectHandler(effect)
            if effect == .beginRetraction {
                initialPose = pose
                elapsed = 0
                isRetracting = true
                currentFrame = makeFrame(pose: pose, progress: 0)
            }
        }
    }

    @discardableResult
    func advance(deltaTime: TimeInterval) async throws -> NozzleRetractionFrame? {
        guard isRetracting, let initialPose else { return nil }
        let retractableLength = max(initialPose.activeLength - minimumActiveLength, 0)
        let duration = max(retractableLength / retractionSpeed, 1.0 / 120.0)
        elapsed += max(deltaTime, 0)
        let progress = min(max(elapsed / duration, 0), 1)
        let frame = makeFrame(pose: initialPose, progress: CGFloat(progress))
        currentFrame = frame
        store.send(.moveNozzle(to: frame.nozzlePoint))

        let reachesDock = progress >= 1 &&
            hypot(frame.nozzlePoint.x - dockPoint.x, frame.nozzlePoint.y - dockPoint.y) <= 0.001 &&
            abs(frame.mouthRotation) <= 0.001 &&
            abs(frame.activeLength - minimumActiveLength) <= 0.001

        if let hoseSession {
            if reachesDock {
                try hoseSession.restoreDockedPose()
            } else {
                try hoseSession.updateDeployment(
                    tipGlobalPoint: NozzlePresentationKinematics.rearCylinderPoint(
                        forNozzleCenter: frame.nozzlePoint,
                        hoseTangent: frame.hoseTangent
                    ),
                    activeLength: frame.activeLength,
                    orientation: simd_quatd(
                        angle: Double(NozzlePresentationKinematics.screenRotation(forHoseTangent: frame.hoseTangent)),
                        axis: SIMD3(0, 0, 1)
                    )
                )
                // Retraction changes both material length and the endpoint pin every
                // frame. `updateDeployment` regenerates the XPBD rest bridge for
                // that exact pose; a second Verlet integration against the prior,
                // longer topology can exceed the angular safety limit on the first
                // shrink frame. The screen-frame interpolation is the motion here.
            }
        }

        if reachesDock {
            isRetracting = false
            store.send(.retractionCompleted)
        }
        return frame
    }

    static func closeButtonPoint(
        nozzlePoint: CGPoint,
        hoseTangent: CGVector
    ) -> CGPoint {
        let length = hypot(hoseTangent.dx, hoseTangent.dy)
        let normalized = length > 0
            ? CGVector(dx: hoseTangent.dx / length, dy: hoseTangent.dy / length)
            : CGVector(dx: 0, dy: 1)
        return CGPoint(
            x: nozzlePoint.x - normalized.dx * 40,
            y: nozzlePoint.y - normalized.dy * 40
        )
    }

    private func makeFrame(
        pose: NozzleRetractionPose,
        progress rawProgress: CGFloat
    ) -> NozzleRetractionFrame {
        let progress = smoothStep(min(max(rawProgress, 0), 1))
        let point = CGPoint(
            x: pose.nozzlePoint.x + (dockPoint.x - pose.nozzlePoint.x) * progress,
            y: pose.nozzlePoint.y + (dockPoint.y - pose.nozzlePoint.y) * progress
        )
        let activeLength = pose.activeLength
            + (minimumActiveLength - pose.activeLength) * Double(progress)
        let mouthRotation = pose.mouthRotation * (1 - progress)
        let hoseTangent = tangent(from: dockPoint, to: point)
        return NozzleRetractionFrame(
            nozzlePoint: point,
            hoseTangent: hoseTangent,
            activeLength: activeLength,
            mouthRotation: mouthRotation,
            closeButtonPoint: Self.closeButtonPoint(
                nozzlePoint: point,
                hoseTangent: hoseTangent
            )
        )
    }

    private func smoothStep(_ value: CGFloat) -> CGFloat {
        value * value * (3 - 2 * value)
    }

    private func tangent(from start: CGPoint, to end: CGPoint) -> CGVector {
        let delta = CGVector(dx: end.x - start.x, dy: end.y - start.y)
        let length = hypot(delta.dx, delta.dy)
        guard length > 0 else { return CGVector(dx: 0, dy: 1) }
        return CGVector(dx: delta.dx / length, dy: delta.dy / length)
    }
}
