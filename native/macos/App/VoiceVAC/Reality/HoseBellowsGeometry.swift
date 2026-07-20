import Foundation
import simd

/// Runtime game mesh for the *visible* part of the Voice VAC hose.
///
/// Blender remains the source of the pearlescent material, the duckbill, and
/// the authored 64-joint reference asset. A desktop hose, however, can expose
/// any fraction of that asset at any length. Re-skinning one fixed mesh makes
/// the inactive reservoir collapse into a stripe. This generator turns the
/// live XPBD centreline into real 3D triangles, preserving the same accordion
/// profile at every extension length.
struct HoseBellowsGeometry: Sendable {
    struct Mesh: Sendable {
        let positions: [SIMD3<Float>]
        let normals: [SIMD3<Float>]
        let textureCoordinates: [SIMD2<Float>]
        let indices: [UInt32]
        /// Tangents sampled on the exact rendered spine. Keeping these with
        /// the mesh makes the C¹ bend rule verifiable without relying on a
        /// screenshot or an implementation detail of the vertex buffers.
        let spineTangents: [SIMD3<Float>]
        let ribCount: Int
        let maximumRadius: Float
    }

    // A mouth-organ hose has fine, closely spaced folds. Four longitudinal
    // samples per period and 24 radial sides are deliberately game-ready:
    // dense enough for a soft plastic surface, lean enough to regenerate as
    // a user drags the mouth across an entire desktop.
    private static let sides = 24
    private static let samplesPerRib = 4
    /// Mirrors the authored Blender UV span (52 ribs / 8) so the Metal PBR
    /// path receives a stable material coordinate regardless of hose length.
    private static let materialUVSpan: Float = 6.5

    static func make(centerline: [SIMD3<Float>]) -> Mesh {
        let cleanPath = deduplicated(centerline)
        guard cleanPath.count >= 2 else {
            return Mesh(
                positions: [], normals: [], textureCoordinates: [], indices: [],
                spineTangents: [], ribCount: 0, maximumRadius: 0
            )
        }

        let lengths = zip(cleanPath, cleanPath.dropFirst()).map(simd_distance)
        let totalLength = lengths.reduce(0, +)
        guard totalLength > 0.000_1 else {
            return Mesh(
                positions: [], normals: [], textureCoordinates: [], indices: [],
                spineTangents: [], ribCount: 0, maximumRadius: 0
            )
        }

        // One small fold about every 12 desktop points gives the reference
        // mouth-organ texture. The cap bounds live topology to ~18k vertices
        // on a full-screen pull, which keeps the Metal update interactive.
        let ribCount = min(max(Int((totalLength * 1_000 / 12).rounded()), 8), 180)
        let ringCount = ribCount * samplesPerRib + 1
        var positions: [SIMD3<Float>] = []
        var normals: [SIMD3<Float>] = []
        var textureCoordinates: [SIMD2<Float>] = []
        var indices: [UInt32] = []
        positions.reserveCapacity(ringCount * sides + 2)
        normals.reserveCapacity(ringCount * sides + 2)
        textureCoordinates.reserveCapacity(ringCount * sides + 2)
        indices.reserveCapacity((ringCount - 1) * sides * 6 + sides * 6)

        var previousNormal: SIMD3<Float>?
        var ringCenters: [SIMD3<Float>] = []
        var spineTangents: [SIMD3<Float>] = []
        ringCenters.reserveCapacity(ringCount)
        spineTangents.reserveCapacity(ringCount)
        var maximumRadius: Float = 0
        for ringIndex in 0..<ringCount {
            let t = Float(ringIndex) / Float(ringCount - 1)
            let sample = pointAndTangent(at: t * totalLength, path: cleanPath, lengths: lengths)
            let tangent = sample.tangent
            let preferred = abs(simd_dot(tangent, SIMD3<Float>(0, 0, 1))) > 0.92
                ? SIMD3<Float>(0, 1, 0)
                : SIMD3<Float>(0, 0, 1)
            var normal = simd_normalize(simd_cross(tangent, preferred))
            if let previousNormal, simd_dot(normal, previousNormal) < 0 {
                normal = -normal
            }
            previousNormal = normal
            let binormal = simd_normalize(simd_cross(tangent, normal))

            let phase = t * Float(ribCount)
            let ridge = 0.5 + 0.5 * cos(2 * .pi * phase)
            let breathing = 1 + 0.035 * sin(2 * .pi * t + 0.43)
                + 0.014 * sin(11 * .pi * t + 0.17)
            // Keep the ridge shallow relative to its 12-point wavelength.
            // The prior 42-point cadence plus a 4.8-point crest read as a
            // necklace of spheres rather than a corrugated vacuum tube.
            let radius = (0.020 + 0.0024 * ridge) * breathing
            maximumRadius = max(maximumRadius, radius)
            ringCenters.append(sample.point)
            spineTangents.append(tangent)
            for side in 0..<sides {
                let angle = 2 * .pi * Float(side) / Float(sides)
                let handmade = 1 + 0.012 * sin(3 * angle + Float(ringIndex) * 0.19)
                    + 0.005 * sin(7 * angle - Float(ringIndex) * 0.11)
                let radial = normal * (cos(angle) * radius * handmade)
                    + binormal * (sin(angle) * radius * handmade)
                positions.append(sample.point + radial)
                textureCoordinates.append(
                    SIMD2(Float(side) / Float(sides), t * materialUVSpan)
                )
            }
        }

        // Use surface derivatives rather than a flat radial normal. This is
        // the difference between a real rounded bellows and a run of sharp
        // paper cones under moving desktop lighting.
        normals.reserveCapacity(ringCount * sides + 2)
        for ringIndex in 0..<ringCount {
            let previousRing = max(ringIndex - 1, 0)
            let nextRing = min(ringIndex + 1, ringCount - 1)
            for side in 0..<sides {
                let previousSide = (side + sides - 1) % sides
                let nextSide = (side + 1) % sides
                let currentIndex = ringIndex * sides + side
                let along = positions[nextRing * sides + side]
                    - positions[previousRing * sides + side]
                let around = positions[ringIndex * sides + nextSide]
                    - positions[ringIndex * sides + previousSide]
                var normal = simd_normalize(simd_cross(along, around))
                let outward = positions[currentIndex] - ringCenters[ringIndex]
                if simd_dot(normal, outward) < 0 { normal = -normal }
                normals.append(normal)
            }
        }

        for ringIndex in 0..<(ringCount - 1) {
            for side in 0..<sides {
                let nextSide = (side + 1) % sides
                let a = UInt32(ringIndex * sides + side)
                let b = UInt32(ringIndex * sides + nextSide)
                let c = UInt32((ringIndex + 1) * sides + nextSide)
                let d = UInt32((ringIndex + 1) * sides + side)
                indices.append(contentsOf: [a, b, c, a, c, d])
            }
        }

        let firstCenter = UInt32(positions.count)
        positions.append(cleanPath[0])
        normals.append(-sampleNormal(at: 0, path: cleanPath))
        textureCoordinates.append(SIMD2(0.5, 0))
        let lastCenter = UInt32(positions.count)
        positions.append(cleanPath[cleanPath.count - 1])
        normals.append(sampleNormal(at: cleanPath.count - 1, path: cleanPath))
        textureCoordinates.append(SIMD2(0.5, materialUVSpan))
        for side in 0..<sides {
            let nextSide = (side + 1) % sides
            indices.append(contentsOf: [firstCenter, UInt32(nextSide), UInt32(side)])
            let last = (ringCount - 1) * sides
            indices.append(contentsOf: [lastCenter, UInt32(last + side), UInt32(last + nextSide)])
        }

        return Mesh(
            positions: positions,
            normals: normals,
            textureCoordinates: textureCoordinates,
            indices: indices,
            spineTangents: spineTangents,
            ribCount: ribCount,
            maximumRadius: maximumRadius
        )
    }

    private static func deduplicated(_ path: [SIMD3<Float>]) -> [SIMD3<Float>] {
        path.reduce(into: []) { result, point in
            if result.last.map({ simd_distance($0, point) > 0.000_01 }) ?? true {
                result.append(point)
            }
        }
    }

    private static func pointAndTangent(
        at distance: Float,
        path: [SIMD3<Float>],
        lengths: [Float]
    ) -> (point: SIMD3<Float>, tangent: SIMD3<Float>) {
        var remaining = distance
        for index in lengths.indices {
            let length = lengths[index]
            if remaining <= length || index == lengths.index(before: lengths.endIndex) {
                let fraction = min(max(remaining / max(length, 0.000_01), 0), 1)
                return hermiteSample(
                    path: path,
                    segmentIndex: index,
                    fraction: fraction,
                    lengths: lengths
                )
            }
            remaining -= length
        }
        return (path[path.count - 1], simd_normalize(path[path.count - 1] - path[path.count - 2]))
    }

    private static func sampleNormal(at index: Int, path: [SIMD3<Float>]) -> SIMD3<Float> {
        let delta: SIMD3<Float>
        if index == 0 {
            delta = path[1] - path[0]
        } else {
            delta = path[path.count - 1] - path[path.count - 2]
        }
        return simd_normalize(delta)
    }

    /// A hose cannot turn as a sequence of straight rigid rods. This cubic
    /// Hermite spline is deliberately local: the physical XPBD nodes remain
    /// the source of truth, while their visual skin gets a C¹ continuous bend
    /// with short, clamped handles. That preserves the user's desired loose
    /// plastic sway without Catmull–Rom overshoot at a tightly folded dock.
    private static func hermiteSample(
        path: [SIMD3<Float>],
        segmentIndex index: Int,
        fraction t: Float,
        lengths: [Float]
    ) -> (point: SIMD3<Float>, tangent: SIMD3<Float>) {
        let p0 = path[index]
        let p1 = path[index + 1]
        let segmentLength = lengths[index]
        let outgoing = visualTangent(at: index, path: path, lengths: lengths)
        let incoming = visualTangent(at: index + 1, path: path, lengths: lengths)
        let handleLength = min(segmentLength * 0.48, 0.090)
        let m0 = outgoing * handleLength
        let m1 = incoming * handleLength

        let t2 = t * t
        let t3 = t2 * t
        let h00 = 2 * t3 - 3 * t2 + 1
        let h10 = t3 - 2 * t2 + t
        let h01 = -2 * t3 + 3 * t2
        let h11 = t3 - t2
        let point = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1

        let dh00 = 6 * t2 - 6 * t
        let dh10 = 3 * t2 - 4 * t + 1
        let dh01 = -6 * t2 + 6 * t
        let dh11 = 3 * t2 - 2 * t
        let derivative = dh00 * p0 + dh10 * m0 + dh01 * p1 + dh11 * m1
        return (point, simd_normalize(derivative))
    }

    private static func visualTangent(
        at index: Int,
        path: [SIMD3<Float>],
        lengths: [Float]
    ) -> SIMD3<Float> {
        if index == 0 {
            return simd_normalize(path[1] - path[0])
        }
        if index == path.count - 1 {
            return simd_normalize(path[index] - path[index - 1])
        }

        let previousLength = max(lengths[index - 1], 0.000_01)
        let nextLength = max(lengths[index], 0.000_01)
        let previousDirection = simd_normalize(path[index] - path[index - 1])
        let nextDirection = simd_normalize(path[index + 1] - path[index])
        let blended = previousDirection * nextLength + nextDirection * previousLength
        return simd_length_squared(blended) > 0.000_000_1
            ? simd_normalize(blended)
            : nextDirection
    }
}
