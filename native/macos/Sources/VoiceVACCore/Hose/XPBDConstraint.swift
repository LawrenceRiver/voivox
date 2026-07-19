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

enum XPBDVectorAngularConstraint {
    static func solveTarget(
        orientation: inout simd_quatd,
        target: simd_quatd,
        inverseMass: Double,
        compliance: Double,
        deltaTime: Double,
        lambda: inout SIMD3<Double>,
        maximumCorrection: Double
    ) {
        guard inverseMass > 0,
              let current = safeNormalizedQuaternion(orientation),
              let target = safeNormalizedQuaternion(target)
        else { return }
        let constraint = rotationVector(target * current.inverse)
        let weightedGradient = inverseMass
        let alphaTilde = compliance / (deltaTime * deltaTime)
        let denominator = weightedGradient + alphaTilde
        guard denominator.isFinite, denominator > 1e-15 else { return }

        var deltaLambda = (-constraint - alphaTilde * lambda) / denominator
        let magnitude = simd_length(deltaLambda)
        if magnitude > maximumCorrection {
            deltaLambda *= maximumCorrection / magnitude
        }
        guard vectorIsFinite(deltaLambda) else { return }
        lambda += deltaLambda
        let correction = -inverseMass * deltaLambda
        orientation = normalizedQuaternion(
            quaternion(rotationVector: correction) * current
        )
    }
}

struct XPBDAngularContinuityConstraint: Sendable {
    let firstIndex: Int
    let secondIndex: Int
    let restRelativeOrientation: simd_quatd
    let compliance: Double
    var lambda: SIMD3<Double> = .zero

    mutating func resetLambda() {
        lambda = .zero
    }

    mutating func solve(
        nodes: inout [HoseNode],
        deltaTime: Double,
        maximumCorrection: Double
    ) {
        let firstWeight = nodes[firstIndex].inverseMass
        let secondWeight = nodes[secondIndex].inverseMass
        let weightedGradient = firstWeight + secondWeight
        let alphaTilde = compliance / (deltaTime * deltaTime)
        let denominator = weightedGradient + alphaTilde
        guard denominator.isFinite, denominator > 1e-15 else { return }

        let desiredSecond = restRelativeOrientation * nodes[firstIndex].orientation
        let constraint = rotationVector(desiredSecond * nodes[secondIndex].orientation.inverse)
        var deltaLambda = (-constraint - alphaTilde * lambda) / denominator
        let magnitude = simd_length(deltaLambda)
        if magnitude > maximumCorrection {
            deltaLambda *= maximumCorrection / magnitude
        }
        guard vectorIsFinite(deltaLambda) else { return }
        lambda += deltaLambda

        if firstWeight > 0 {
            nodes[firstIndex].orientation = normalizedQuaternion(
                quaternion(rotationVector: firstWeight * deltaLambda) *
                    nodes[firstIndex].orientation
            )
        }
        if secondWeight > 0 {
            nodes[secondIndex].orientation = normalizedQuaternion(
                quaternion(rotationVector: -secondWeight * deltaLambda) *
                    nodes[secondIndex].orientation
            )
        }
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

func minimalRotation(
    from source: SIMD3<Double>,
    to destination: SIMD3<Double>,
    preferredAxis: SIMD3<Double>
) -> simd_quatd {
    guard vectorIsFinite(source), vectorIsFinite(destination),
          simd_length(source) > 1e-10, simd_length(destination) > 1e-10
    else { return .identity }
    let source = simd_normalize(source)
    let destination = simd_normalize(destination)
    let cosine = max(-1, min(1, simd_dot(source, destination)))
    if cosine > 1 - 1e-12 { return .identity }
    if cosine < -1 + 1e-10 {
        var axis = preferredAxis - source * simd_dot(preferredAxis, source)
        if simd_length(axis) < 1e-9 {
            let fallback = abs(source.z) < 0.8
                ? SIMD3<Double>(0, 0, 1)
                : SIMD3<Double>(0, 1, 0)
            axis = fallback - source * simd_dot(fallback, source)
        }
        return simd_quatd(angle: .pi, axis: simd_normalize(axis))
    }
    let axis = simd_cross(source, destination)
    return normalizedQuaternion(
        simd_quatd(vector: SIMD4(axis.x, axis.y, axis.z, 1 + cosine))
    )
}

func rotationVector(_ quaternion: simd_quatd) -> SIMD3<Double> {
    guard var quaternion = safeNormalizedQuaternion(quaternion) else { return .zero }
    if quaternion.real < 0 {
        quaternion = simd_quatd(vector: -quaternion.vector)
    }
    let imaginary = quaternion.imag
    let sineHalfAngle = simd_length(imaginary)
    guard sineHalfAngle > 1e-12 else { return .zero }
    let angle = 2 * atan2(sineHalfAngle, max(-1, min(1, quaternion.real)))
    return imaginary / sineHalfAngle * angle
}

func quaternion(rotationVector: SIMD3<Double>) -> simd_quatd {
    let angle = simd_length(rotationVector)
    guard angle.isFinite, angle > 1e-12 else { return .identity }
    return simd_quatd(angle: angle, axis: rotationVector / angle)
}

func hemisphereSlerp(
    _ first: simd_quatd,
    _ second: simd_quatd,
    fraction: Double
) -> simd_quatd {
    let first = normalizedQuaternion(first)
    var second = normalizedQuaternion(second)
    var cosine = simd_dot(first.vector, second.vector)
    if cosine < 0 {
        second = simd_quatd(vector: -second.vector)
        cosine = -cosine
    }
    let fraction = min(max(fraction, 0), 1)
    if cosine > 0.9995 {
        return normalizedQuaternion(
            simd_quatd(vector: first.vector + (second.vector - first.vector) * fraction)
        )
    }
    let angle = acos(max(-1, min(1, cosine)))
    let denominator = sin(angle)
    guard abs(denominator) > 1e-12 else { return first }
    let firstWeight = sin((1 - fraction) * angle) / denominator
    let secondWeight = sin(fraction * angle) / denominator
    return normalizedQuaternion(
        simd_quatd(vector: first.vector * firstWeight + second.vector * secondWeight)
    )
}
