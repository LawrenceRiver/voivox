import Foundation
import simd

public struct HoseNode: Equatable, Sendable {
    public let materialID: UInt64
    public internal(set) var position: SIMD3<Double>
    public internal(set) var previousPosition: SIMD3<Double>
    public internal(set) var orientation: simd_quatd
    public internal(set) var inverseMass: Double

    init(
        materialID: UInt64,
        position: SIMD3<Double>,
        orientation: simd_quatd,
        inverseMass: Double
    ) {
        self.materialID = materialID
        self.position = position
        self.previousPosition = position
        self.orientation = orientation
        self.inverseMass = inverseMass
    }
}
