import CoreGraphics
import simd
import VoiceVACCore

enum HoseRenderSessionError: Error, Equatable {
    case simulation(HoseSimulationFailure)
    case unavailableSimulationFailure
    case rendering(HoseRigControllerError)
}

/// Production composition boundary from the XPBD rod to every Metal viewport.
@MainActor
final class HoseRenderSession {
    let source: HoseRenderSnapshotSource
    private(set) var rod: HoseRod
    private let controller: HoseRigController

    init(
        source: HoseRenderSnapshotSource,
        configuration: HoseConfiguration = .voiceVAC,
        seed: UInt64 = 0x5641_4356_4f58,
        controller: HoseRigController = HoseRigController()
    ) {
        self.source = source
        rod = HoseRod(configuration: configuration, seed: seed)
        self.controller = controller
    }

    /// Publishes the short physical segment concealed beneath the docked nozzle.
    func dock(in nozzleFrame: CGRect) throws {
        let length = rod.configuration.naturalSegmentLength
        let tip = SIMD3<Double>(nozzleFrame.midX, nozzleFrame.midY, 0)
        let root = SIMD3<Double>(tip.x + length, tip.y, 0)
        let facingLeft = simd_quatd(angle: .pi, axis: SIMD3(0, 0, 1))
        let result = rod.configurePins(
            rootPosition: root,
            rootOrientation: facingLeft,
            tipPosition: tip,
            tipOrientation: facingLeft,
            activeLength: length
        )
        guard case let .failure(failure) = result else {
            try publishCurrentSnapshot()
            return
        }
        let error = HoseRenderSessionError.simulation(failure)
        source.publishError(error)
        throw error
    }

    func updateDeployment(
        tipGlobalPoint: CGPoint,
        activeLength: Double,
        orientation: simd_quatd
    ) throws {
        let result = rod.updateDeployment(
            tipPosition: SIMD3(tipGlobalPoint.x, tipGlobalPoint.y, 0),
            tipOrientation: orientation,
            activeLength: activeLength
        )
        guard case let .failure(failure) = result else {
            try publishCurrentSnapshot()
            return
        }
        let error = HoseRenderSessionError.simulation(failure)
        source.publishError(error)
        throw error
    }

    func step(deltaTime: Double, iterations: Int? = nil) throws {
        guard !rod.step(deltaTime: deltaTime, iterations: iterations) else {
            try publishCurrentSnapshot()
            return
        }
        let error = rod.lastFailure.map(HoseRenderSessionError.simulation)
            ?? HoseRenderSessionError.unavailableSimulationFailure
        source.publishError(error)
        throw error
    }

    func publish(_ snapshot: HoseSnapshot) throws {
        do {
            source.publish(
                try controller.makeRenderSnapshot(from: snapshot.fixedRigSnapshot())
            )
        } catch let error as HoseRigControllerError {
            let sessionError = HoseRenderSessionError.rendering(error)
            source.publishError(sessionError)
            throw sessionError
        }
    }

    private func publishCurrentSnapshot() throws {
        try publish(rod.snapshot)
    }
}
