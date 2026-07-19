import Foundation
import simd

public struct HoseJointSample: Equatable, Sendable {
    public let jointIndex: Int
    public let materialID: UInt64
    public let normalizedMaterialCoordinate: Double
    public let position: SIMD3<Double>
    public let orientation: simd_quatd

    public init(
        jointIndex: Int,
        materialID: UInt64,
        normalizedMaterialCoordinate: Double,
        position: SIMD3<Double>,
        orientation: simd_quatd
    ) {
        self.jointIndex = jointIndex
        self.materialID = materialID
        self.normalizedMaterialCoordinate = normalizedMaterialCoordinate
        self.position = position
        self.orientation = orientation
    }
}

public struct HoseSnapshot: Equatable, Sendable {
    public let activeLength: Double
    public let maximumActiveLength: Double
    public let joints: [HoseJointSample]

    public init(
        activeLength: Double,
        maximumActiveLength: Double,
        joints: [HoseJointSample]
    ) {
        self.activeLength = activeLength
        self.maximumActiveLength = maximumActiveLength
        self.joints = joints
    }
}

public enum HoseRigJointActivity: String, Equatable, Sendable {
    case active
    case inactiveReservoir
}

public struct HoseRigJointSample: Equatable, Sendable {
    public let rigIndex: Int
    public let normalizedMaterialCoordinate: Double
    public let activity: HoseRigJointActivity
    public let position: SIMD3<Double>
    public let orientation: simd_quatd
}

public struct HoseRigSnapshot: Equatable, Sendable {
    public static let jointCount = 64
    public let joints: [HoseRigJointSample]

    public init(joints: [HoseRigJointSample]) {
        precondition(joints.count == Self.jointCount)
        self.joints = joints
    }
}

public extension HoseSnapshot {
    func fixedRigSnapshot() -> HoseRigSnapshot {
        guard let root = joints.first, let tip = joints.last else {
            let identity = simd_quatd.identity
            return HoseRigSnapshot(
                joints: (0..<HoseRigSnapshot.jointCount).map { index in
                    HoseRigJointSample(
                        rigIndex: index,
                        normalizedMaterialCoordinate: Double(index) /
                            Double(HoseRigSnapshot.jointCount - 1),
                        activity: .inactiveReservoir,
                        position: .zero,
                        orientation: identity
                    )
                }
            )
        }

        let safeMaximum = max(maximumActiveLength, 1e-9)
        let reservoirBoundary = min(max(1 - activeLength / safeMaximum, 0), 1)
        var mapped: [HoseRigJointSample] = []
        mapped.reserveCapacity(HoseRigSnapshot.jointCount)

        for index in 0..<HoseRigSnapshot.jointCount {
            let coordinate = Double(index) / Double(HoseRigSnapshot.jointCount - 1)
            let activity: HoseRigJointActivity = coordinate + 1e-12 < reservoirBoundary
                ? .inactiveReservoir
                : .active
            let pose: (SIMD3<Double>, simd_quatd)
            if index == 0 || activity == .inactiveReservoir {
                pose = (root.position, root.orientation)
            } else if index == HoseRigSnapshot.jointCount - 1 {
                pose = (tip.position, tip.orientation)
            } else {
                pose = interpolatedPose(at: coordinate)
            }
            var orientation = normalizedQuaternion(pose.1)
            if let previous = mapped.last,
               simd_dot(previous.orientation.vector, orientation.vector) < 0 {
                orientation = simd_quatd(vector: -orientation.vector)
            }
            mapped.append(
                HoseRigJointSample(
                    rigIndex: index,
                    normalizedMaterialCoordinate: coordinate,
                    activity: activity,
                    position: pose.0,
                    orientation: orientation
                )
            )
        }
        return HoseRigSnapshot(joints: mapped)
    }

    private func interpolatedPose(
        at coordinate: Double
    ) -> (SIMD3<Double>, simd_quatd) {
        guard let first = joints.first, let last = joints.last else {
            return (.zero, .identity)
        }
        if coordinate <= first.normalizedMaterialCoordinate {
            return (first.position, first.orientation)
        }
        if coordinate >= last.normalizedMaterialCoordinate {
            return (last.position, last.orientation)
        }

        for upperIndex in 1..<joints.count {
            let lower = joints[upperIndex - 1]
            let upper = joints[upperIndex]
            guard coordinate <= upper.normalizedMaterialCoordinate else { continue }
            let span = upper.normalizedMaterialCoordinate - lower.normalizedMaterialCoordinate
            let fraction = span > 1e-12
                ? min(max((coordinate - lower.normalizedMaterialCoordinate) / span, 0), 1)
                : 0
            return (
                simd_mix(lower.position, upper.position, SIMD3(repeating: fraction)),
                hemisphereSlerp(lower.orientation, upper.orientation, fraction: fraction)
            )
        }
        return (last.position, last.orientation)
    }
}
