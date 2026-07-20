import CoreGraphics
import simd
import VoiceVACCore

enum HoseRenderSessionError: Error, Equatable {
    case simulation(HoseSimulationFailure)
    case unavailableSimulationFailure
    case rendering(HoseRigControllerError)
    case visualDeploymentRequiresDock
}

/// Production composition boundary from the XPBD rod to every Metal viewport.
@MainActor
final class HoseRenderSession {
    let source: HoseRenderSnapshotSource
    private(set) var rod: HoseRod
    private let controller: HoseRigController
    private let visualSwayPhase: Double
    private(set) var dockFrame: CGRect?
    private(set) var rootGlobalPoint: CGPoint?
    private var showsExternalHose = false

    /// Eight material bays make a short, readable idle lead without asking a
    /// flexible tube to self-intersect inside the capsule. The full bellows
    /// is generated from the physical path as soon as the user pulls it.
    var stowedActiveLength: Double {
        min(
            rod.configuration.naturalSegmentLength * 8,
            rod.configuration.maximumActiveLength
        )
    }

    init(
        source: HoseRenderSnapshotSource,
        configuration: HoseConfiguration = .voiceVAC,
        seed: UInt64 = 0x5641_4356_4f58,
        controller: HoseRigController = HoseRigController()
    ) {
        self.source = source
        rod = HoseRod(configuration: configuration, seed: seed)
        self.controller = controller
        visualSwayPhase = Double(seed & 0xFFFF) / Double(0xFFFF) * (.pi * 2)
    }

    /// Anchors the physical root at the centre of the capsule's dark port.
    /// The stored length is intentionally invisible while docked, but the
    /// moment the user pulls the mouth out, this exact point becomes the only
    /// legitimate external outlet for the rendered tube.
    func dock(in nozzleFrame: CGRect) throws {
        dockFrame = nozzleFrame
        showsExternalHose = false
        let length = stowedActiveLength
        let outlet = SIMD3<Double>(nozzleFrame.midX, nozzleFrame.midY, 0)
        rootGlobalPoint = CGPoint(x: outlet.x, y: outlet.y)
        let facingLeft = simd_quatd(angle: .pi, axis: SIMD3(0, 0, 1))
        let result = rod.configurePins(
            rootPosition: outlet,
            rootOrientation: facingLeft,
            tipPosition: outlet,
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

    /// Creates the deliberately soft lead-in used while the user is pulling
    /// the mouth. The 18% reserve turns the same physical rig into a readable
    /// C/S curve instead of allowing the visible hose to become a taut line.
    func deployVisual(
        toward tipGlobalPoint: CGPoint,
        orientation: simd_quatd = simd_quatd(
            angle: .pi / 2,
            axis: SIMD3(0, 0, 1)
        )
    ) throws {
        guard let rootGlobalPoint else {
            throw HoseRenderSessionError.visualDeploymentRequiresDock
        }
        let span = Double(hypot(
            tipGlobalPoint.x - rootGlobalPoint.x,
            tipGlobalPoint.y - rootGlobalPoint.y
        ))
        let activeLength = min(
            max(stowedActiveLength, span * 1.18),
            rod.configuration.maximumActiveLength
        )
        showsExternalHose = true
        try updateDeployment(
            tipGlobalPoint: tipGlobalPoint,
            activeLength: activeLength,
            orientation: orientation
        )
        try step(deltaTime: 1.0 / 60.0)
    }

    /// Return the XPBD rig to the same stable multi-bay pose used at launch.
    /// Retraction must not leave a one-segment endpoint state behind just
    /// because the mouth is precisely over the dock.
    func restoreDockedPose() throws {
        guard let dockFrame else {
            throw HoseRenderSessionError.visualDeploymentRequiresDock
        }
        try dock(in: dockFrame)
    }

    /// Moves the machine-side outlet while preserving a mouth that is already
    /// attached to a page. This is the external counterpart to `dock(in:)`:
    /// the glass capsule may move, but the hose must never retain a ghost root
    /// at the capsule's previous screen position.
    func reanchorExternalHose(to nozzleFrame: CGRect) throws {
        guard showsExternalHose else {
            try dock(in: nozzleFrame)
            return
        }
        let snapshot = rod.snapshot
        guard let root = snapshot.joints.first,
              let tip = snapshot.joints.last
        else { throw HoseRenderSessionError.unavailableSimulationFailure }

        let outlet = SIMD3<Double>(nozzleFrame.midX, nozzleFrame.midY, 0)
        let span = simd_distance(outlet, tip.position)
        let activeLength = min(
            max(stowedActiveLength, span * 1.18),
            rod.configuration.maximumActiveLength
        )
        let result = rod.configurePins(
            rootPosition: outlet,
            rootOrientation: root.orientation,
            tipPosition: tip.position,
            tipOrientation: tip.orientation,
            activeLength: activeLength
        )
        guard case let .failure(failure) = result else {
            dockFrame = nozzleFrame
            rootGlobalPoint = CGPoint(x: outlet.x, y: outlet.y)
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
            let activeFraction = min(
                max(snapshot.activeLength / max(snapshot.maximumActiveLength, 1e-9), 0),
                1
            )
            source.publish(
                try controller.makeRenderSnapshot(
                    from: snapshot.fixedRigSnapshot(),
                    activeMaterialStart: Float(1 - activeFraction),
                    centerline: renderedCenterline(for: snapshot),
                    showsExternalHose: showsExternalHose
                )
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

    /// Converts physical length surplus into a constrained visual neutral
    /// axis. The XPBD endpoints and available material length remain the
    /// authority; this layer only distributes their slack as the loose,
    /// flexible C/S sweep a plastic vacuum hose exhibits between solver ticks.
    /// It is deliberately arc-bounded, so the renderer never invents more
    /// tube than the actual XPBD state owns.
    private func renderedCenterline(for snapshot: HoseSnapshot) -> [SIMD3<Float>] {
        let physicalPath = snapshot.joints.map {
            SIMD3<Double>(
                $0.position.x / 1_000,
                $0.position.y / 1_000,
                $0.position.z / 1_000
            )
        }
        guard showsExternalHose,
              let start = physicalPath.first,
              let end = physicalPath.last
        else {
            return physicalPath.map { SIMD3<Float>(Float($0.x), Float($0.y), Float($0.z)) }
        }

        let chord = end - start
        let span = simd_length(chord)
        let slack = max(snapshot.activeLength / 1_000 - span, 0)
        guard span > 0.000_1, slack > 0.010 else {
            return physicalPath.map { SIMD3<Float>(Float($0.x), Float($0.y), Float($0.z)) }
        }

        let tangent = chord / span
        let lateral = SIMD3<Double>(-tangent.y, tangent.x, 0)
        // For a sine bow, pi² A² / (4 L) is the small-angle arc-length
        // surplus. Stay below that amplitude to honor available material.
        let maximumArcBoundedAmplitude = sqrt(4 * span * slack) / .pi
        let amplitude = min(maximumArcBoundedAmplitude * 0.90, slack * 1.34)
        let sampleCount = max(18, min(48, Int(span * 1_000 / 36)))

        return (0...sampleCount).map { index in
            let t = Double(index) / Double(sampleCount)
            let envelope = sin(.pi * t)
            // Preserve one broad C sweep but make its body feel handmade,
            // rather than a mathematically sterile parabola.
            let handmade = 1 + 0.13 * sin(2 * .pi * t + visualSwayPhase)
                + 0.045 * sin(5 * .pi * t + visualSwayPhase * 0.61)
            let offset = lateral * (amplitude * envelope * handmade)
            let depth = 0.0045 * envelope * sin(2 * .pi * t + visualSwayPhase * 0.73)
            let point = start + chord * t + offset + SIMD3<Double>(0, 0, depth)
            return SIMD3<Float>(Float(point.x), Float(point.y), Float(point.z))
        }
    }
}
