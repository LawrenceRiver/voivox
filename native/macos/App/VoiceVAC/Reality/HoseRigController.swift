import Foundation
import simd
import VoiceVACCore

enum HoseRigControllerError: Error, Equatable {
    case invalidPointsPerMeter
    case invalidJointCount(actual: Int)
    case invalidJointOrder(expected: Int, actual: Int)
    case nonFinitePose(index: Int)
}

/// A frame is immutable and reference-shared by every display viewport.
final class HoseRenderSnapshot: Sendable {
    static let jointNames = (0..<HoseRigSnapshot.jointCount).map {
        String(format: "VAC_HOSE_JOINT_%02d", $0)
    }
    static let bindPose = HoseRenderSnapshot(
        jointMatrices: Array(repeating: matrix_identity_float4x4, count: HoseRigSnapshot.jointCount),
        correctiveWeights: .zero
    )

    let jointNames: [String]
    let jointMatrices: [simd_float4x4]
    let correctiveWeights: SIMD2<Float>
    /// The unused mechanical reservoir is intentionally collapsed by the
    /// XPBD topology. Rendering that collapsed geometry produces a hard,
    /// striped knot, so Metal clips it before it reaches the desktop.
    let activeMaterialStart: Float
    /// World-space XPBD path, in metres. Metal turns this into the live
    /// accordion mesh so a variable-length hose never collapses a fixed skin.
    let centerline: [SIMD3<Float>]
    /// A docked Voice VAC stores its hose inside the capsule. The external
    /// game mesh appears only after the user begins pulling the mouth out.
    let showsExternalHose: Bool

    init(
        jointMatrices: [simd_float4x4],
        correctiveWeights: SIMD2<Float>,
        activeMaterialStart: Float = 0,
        centerline: [SIMD3<Float>] = [],
        showsExternalHose: Bool = true
    ) {
        precondition(jointMatrices.count == HoseRigSnapshot.jointCount)
        jointNames = Self.jointNames
        self.jointMatrices = jointMatrices
        self.correctiveWeights = correctiveWeights
        self.activeMaterialStart = min(max(activeMaterialStart, 0), 1)
        self.centerline = centerline
        self.showsExternalHose = showsExternalHose
    }
}

struct HoseRigController: Sendable {
    let pointsPerMeter: Double

    init(pointsPerMeter: Double = 1_000) {
        self.pointsPerMeter = pointsPerMeter
    }

    func makeRenderSnapshot(
        from rig: HoseRigSnapshot,
        activeMaterialStart: Float = 0,
        centerline: [SIMD3<Float>] = [],
        showsExternalHose: Bool = true
    ) throws -> HoseRenderSnapshot {
        guard pointsPerMeter.isFinite, pointsPerMeter > 0 else {
            throw HoseRigControllerError.invalidPointsPerMeter
        }
        guard rig.joints.count == HoseRigSnapshot.jointCount else {
            throw HoseRigControllerError.invalidJointCount(actual: rig.joints.count)
        }

        var matrices: [simd_float4x4] = []
        matrices.reserveCapacity(HoseRigSnapshot.jointCount)
        for (expectedIndex, joint) in rig.joints.enumerated() {
            guard joint.rigIndex == expectedIndex else {
                throw HoseRigControllerError.invalidJointOrder(
                    expected: expectedIndex,
                    actual: joint.rigIndex
                )
            }
            let position = joint.position / pointsPerMeter
            let quaternion = joint.orientation.vector
            guard position.x.isFinite, position.y.isFinite, position.z.isFinite,
                  quaternion.x.isFinite, quaternion.y.isFinite,
                  quaternion.z.isFinite, quaternion.w.isFinite
            else { throw HoseRigControllerError.nonFinitePose(index: expectedIndex) }

            var transform = simd_float4x4(
                simd_quatf(ix: Float(quaternion.x), iy: Float(quaternion.y),
                           iz: Float(quaternion.z), r: Float(quaternion.w))
            )
            transform.columns.3 = SIMD4(
                Float(position.x), Float(position.y), Float(position.z), 1
            )
            matrices.append(transform)
        }

        return HoseRenderSnapshot(
            jointMatrices: matrices,
            correctiveWeights: correctiveWeights(for: rig),
            activeMaterialStart: activeMaterialStart,
            centerline: centerline,
            showsExternalHose: showsExternalHose
        )
    }

    private func correctiveWeights(for rig: HoseRigSnapshot) -> SIMD2<Float> {
        var positive = 0.0
        var negative = 0.0
        for index in 1..<(rig.joints.count - 1) {
            let incoming = rig.joints[index].position - rig.joints[index - 1].position
            let outgoing = rig.joints[index + 1].position - rig.joints[index].position
            let denominator = max(simd_length(incoming) * simd_length(outgoing), 1e-9)
            let signedBend = (incoming.x * outgoing.y - incoming.y * outgoing.x) / denominator
            positive += max(signedBend, 0)
            negative += max(-signedBend, 0)
        }
        let divisor = Double(max(rig.joints.count - 2, 1))
        return SIMD2(
            Float(min(positive / divisor * 8, 1)),
            Float(min(negative / divisor * 8, 1))
        )
    }
}
