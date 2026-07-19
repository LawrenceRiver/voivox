import Foundation
import simd

public struct HoseJointSample: Equatable, Sendable {
    public let jointIndex: Int
    public let materialID: UInt64
    public let position: SIMD3<Double>
    public let orientation: simd_quatd

    public init(
        jointIndex: Int,
        materialID: UInt64,
        position: SIMD3<Double>,
        orientation: simd_quatd
    ) {
        self.jointIndex = jointIndex
        self.materialID = materialID
        self.position = position
        self.orientation = orientation
    }
}

public struct HoseSnapshot: Equatable, Sendable {
    public let activeLength: Double
    public let joints: [HoseJointSample]

    public init(activeLength: Double, joints: [HoseJointSample]) {
        self.activeLength = activeLength
        self.joints = joints
    }
}
