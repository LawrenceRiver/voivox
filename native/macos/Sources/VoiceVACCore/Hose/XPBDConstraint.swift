import Foundation
import simd

public extension simd_quatd {
    static var identity: simd_quatd {
        simd_quatd(ix: 0, iy: 0, iz: 0, r: 1)
    }
}

struct XPBDDistanceConstraint: Sendable {
    let firstIndex: Int
    let secondIndex: Int
    let restLength: Double
    let compliance: Double
    var lambda: Double = 0

    mutating func resetLambda() {
        lambda = 0
    }

    mutating func solve(
        nodes: inout [HoseNode],
        deltaTime: Double,
        maximumCorrection: Double
    ) {
        let delta = nodes[secondIndex].position - nodes[firstIndex].position
        let distance = simd_length(delta)
        guard distance.isFinite, distance > 1e-12 else { return }

        let firstWeight = nodes[firstIndex].inverseMass
        let secondWeight = nodes[secondIndex].inverseMass
        let weightedGradient = firstWeight + secondWeight
        let alphaTilde = compliance / (deltaTime * deltaTime)
        let denominator = weightedGradient + alphaTilde
        guard denominator.isFinite, denominator > 1e-15 else { return }

        let constraint = distance - restLength
        var deltaLambda = (-constraint - alphaTilde * lambda) / denominator
        deltaLambda = min(max(deltaLambda, -maximumCorrection), maximumCorrection)
        guard deltaLambda.isFinite else { return }
        lambda += deltaLambda

        let direction = delta / distance
        nodes[firstIndex].position -= firstWeight * deltaLambda * direction
        nodes[secondIndex].position += secondWeight * deltaLambda * direction
    }
}

enum XPBDOrientationConstraint {
    static func solve(
        orientation: inout simd_quatd,
        target: simd_quatd,
        inverseMass: Double,
        compliance: Double,
        deltaTime: Double,
        lambda: inout Double
    ) {
        guard inverseMass > 0,
              let current = safeNormalizedQuaternion(orientation),
              let target = safeNormalizedQuaternion(target)
        else { return }

        var difference = target * current.inverse
        if difference.real < 0 {
            difference = simd_quatd(vector: -difference.vector)
        }
        let imaginary = SIMD3(
            difference.imag.x,
            difference.imag.y,
            difference.imag.z
        )
        let imaginaryLength = simd_length(imaginary)
        guard imaginaryLength.isFinite, imaginaryLength > 1e-12 else {
            orientation = target
            return
        }

        let axis = imaginary / imaginaryLength
        let constraint = 2 * atan2(imaginaryLength, max(-1, min(1, difference.real)))
        let weightedGradient = inverseMass
        let alphaTilde = compliance / (deltaTime * deltaTime)
        let denominator = weightedGradient + alphaTilde
        guard denominator.isFinite, denominator > 1e-15 else { return }

        let deltaLambda = (-constraint - alphaTilde * lambda) / denominator
        guard deltaLambda.isFinite else { return }
        lambda += deltaLambda
        let correction = min(max(-inverseMass * deltaLambda, 0), .pi / 3)
        orientation = normalizedQuaternion(
            simd_quatd(angle: correction, axis: axis) * current
        )
    }
}

@inline(__always)
func vectorIsFinite(_ value: SIMD3<Double>) -> Bool {
    value.x.isFinite && value.y.isFinite && value.z.isFinite
}

@inline(__always)
func quaternionIsFinite(_ value: simd_quatd) -> Bool {
    value.vector.x.isFinite && value.vector.y.isFinite &&
        value.vector.z.isFinite && value.vector.w.isFinite
}

@inline(__always)
func safeNormalizedQuaternion(_ value: simd_quatd) -> simd_quatd? {
    guard quaternionIsFinite(value) else { return nil }
    let length = simd_length(value.vector)
    guard length.isFinite, length > 1e-12 else { return nil }
    return simd_quatd(vector: value.vector / length)
}

@inline(__always)
func normalizedQuaternion(_ value: simd_quatd) -> simd_quatd {
    safeNormalizedQuaternion(value) ?? .identity
}

func orientationFromForward(_ forward: SIMD3<Double>) -> simd_quatd {
    guard vectorIsFinite(forward) else { return .identity }
    let length = simd_length(forward)
    guard length > 1e-10 else { return .identity }
    let destination = forward / length
    let source = SIMD3<Double>(1, 0, 0)
    let cosine = max(-1, min(1, simd_dot(source, destination)))

    if cosine > 1 - 1e-12 {
        return .identity
    }
    if cosine < -1 + 1e-10 {
        return simd_quatd(angle: .pi, axis: SIMD3(0, 1, 0))
    }

    let axis = simd_cross(source, destination)
    return normalizedQuaternion(
        simd_quatd(vector: SIMD4(axis.x, axis.y, axis.z, 1 + cosine))
    )
}
