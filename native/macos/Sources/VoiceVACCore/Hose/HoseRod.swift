import Foundation
import simd

public struct HoseRod: Sendable {
    public let configuration: HoseConfiguration
    public private(set) var activeLength: Double

    private let seed: UInt64
    private var nodes: [HoseNode]
    private var stretchConstraints: [XPBDDistanceConstraint]
    private var bendConstraints: [XPBDDistanceConstraint]
    private var orientationLambdas: [Double]
    private var rootPin: (position: SIMD3<Double>, orientation: simd_quatd)
    private var tipPin: (position: SIMD3<Double>, orientation: simd_quatd)
    private var nextMaterialID: UInt64
    private var hasExplicitTipPin: Bool

    public init(configuration: HoseConfiguration, seed: UInt64) {
        self.configuration = configuration
        self.seed = seed
        activeLength = configuration.naturalSegmentLength
        let root = HoseNode(
            materialID: 0,
            position: .zero,
            orientation: .identity,
            inverseMass: 0
        )
        let tipPosition = SIMD3<Double>(configuration.naturalSegmentLength, 0, 0)
        let tip = HoseNode(
            materialID: 1,
            position: tipPosition,
            orientation: .identity,
            inverseMass: 0
        )
        nodes = [root, tip]
        rootPin = (.zero, .identity)
        tipPin = (tipPosition, .identity)
        nextMaterialID = 2
        hasExplicitTipPin = false
        stretchConstraints = []
        bendConstraints = []
        orientationLambdas = [0, 0]
        rebuildConstraints()
    }

    public var activeNodeCount: Int {
        nodes.count
    }

    public var snapshot: HoseSnapshot {
        HoseSnapshot(
            activeLength: activeLength,
            joints: nodes.enumerated().map { index, node in
                HoseJointSample(
                    jointIndex: index,
                    materialID: node.materialID,
                    position: node.position,
                    orientation: node.orientation
                )
            }
        )
    }

    public var maximumSegmentStrain: Double {
        guard nodes.count > 1 else { return 0 }
        let lengths = restSegmentLengths()
        return zip(nodes.indices.dropLast(), lengths).reduce(0) { maximum, item in
            let index = item.0
            let restLength = item.1
            guard restLength > 1e-12 else { return maximum }
            let current = simd_distance(nodes[index].position, nodes[index + 1].position)
            let strain = abs(current - restLength) / restLength
            return strain.isFinite ? max(maximum, strain) : .infinity
        }
    }

    public var maximumDistanceFromRoot: Double {
        guard let root = nodes.first?.position else { return 0 }
        return nodes.reduce(0) { maximum, node in
            let distance = simd_distance(root, node.position)
            return distance.isFinite ? max(maximum, distance) : .infinity
        }
    }

    @discardableResult
    public mutating func pinRoot(
        _ position: SIMD3<Double>,
        orientation: simd_quatd
    ) -> Bool {
        guard vectorIsFinite(position),
              let orientation = safeNormalizedQuaternion(orientation)
        else { return false }

        rootPin = (position, orientation)
        nodes[0].position = position
        nodes[0].previousPosition = position
        nodes[0].orientation = orientation
        nodes[0].inverseMass = 0
        return true
    }

    @discardableResult
    public mutating func pinTip(
        _ position: SIMD3<Double>,
        orientation: simd_quatd
    ) -> Bool {
        guard vectorIsFinite(position),
              let orientation = safeNormalizedQuaternion(orientation)
        else { return false }

        tipPin = (position, orientation)
        nodes[nodes.count - 1].position = position
        nodes[nodes.count - 1].previousPosition = position
        nodes[nodes.count - 1].orientation = orientation
        nodes[nodes.count - 1].inverseMass = 0
        if !hasExplicitTipPin, nodes.count > 2 {
            layoutInteriorAlongRestCurve()
            rebuildConstraints()
        }
        hasExplicitTipPin = true
        return true
    }

    @discardableResult
    public mutating func setActiveLength(_ requestedLength: Double) -> Bool {
        guard requestedLength.isFinite else { return false }
        let clamped = min(max(requestedLength, 0), configuration.maximumActiveLength)
        guard clamped != activeLength else { return true }

        let previousCount = nodes.count
        activeLength = clamped
        let desiredCount = desiredNodeCount(for: clamped)
        reconcileTopology(from: previousCount, to: desiredCount)
        rebuildConstraints()
        projectPins()
        return true
    }

    public mutating func retract(by amount: Double) {
        guard amount.isFinite, amount > 0 else { return }
        _ = setActiveLength(activeLength - amount)
    }

    @discardableResult
    public mutating func step(
        deltaTime: Double,
        iterations requestedIterations: Int? = nil
    ) -> Bool {
        let iterations = requestedIterations ?? configuration.solverIterations
        guard deltaTime.isFinite, deltaTime > 0, deltaTime <= 0.1,
              iterations > 0, iterations <= 256
        else { return false }

        let rollbackNodes = nodes
        let rollbackStretch = stretchConstraints
        let rollbackBend = bendConstraints
        let rollbackOrientationLambdas = orientationLambdas

        integrateFreeNodes()
        projectPins()
        for index in stretchConstraints.indices {
            stretchConstraints[index].resetLambda()
        }
        for index in bendConstraints.indices {
            bendConstraints[index].resetLambda()
        }
        orientationLambdas = Array(repeating: 0, count: nodes.count)

        let maximumCorrection = configuration.maximumStepDisplacement
        for _ in 0..<iterations {
            for index in stretchConstraints.indices {
                stretchConstraints[index].solve(
                    nodes: &nodes,
                    deltaTime: deltaTime,
                    maximumCorrection: maximumCorrection
                )
            }
            for index in bendConstraints.indices {
                bendConstraints[index].solve(
                    nodes: &nodes,
                    deltaTime: deltaTime,
                    maximumCorrection: maximumCorrection * 0.65
                )
            }
            projectPins()
        }

        // Bend projection perturbs adjacent lengths. End each frame with several
        // hard stretch sweeps so the rendered corrugations never hide elongation.
        for _ in 0..<iterations {
            for index in stretchConstraints.indices {
                stretchConstraints[index].solve(
                    nodes: &nodes,
                    deltaTime: deltaTime,
                    maximumCorrection: maximumCorrection
                )
            }
            projectPins()
        }

        solveOrientations(deltaTime: deltaTime, iterations: iterations)
        projectPins()
        stabilizeVerletHistory(relativeTo: rollbackNodes)

        guard allStateIsFinite() else {
            nodes = rollbackNodes
            stretchConstraints = rollbackStretch
            bendConstraints = rollbackBend
            orientationLambdas = rollbackOrientationLambdas
            return false
        }
        return true
    }

    private func desiredNodeCount(for length: Double) -> Int {
        guard length > 0 else { return 2 }
        let segments = Int(ceil(length / configuration.naturalSegmentLength))
        return min(configuration.maximumNodeCount, max(2, segments + 1))
    }

    private mutating func reconcileTopology(from oldCount: Int, to newCount: Int) {
        guard oldCount != newCount else { return }

        if newCount > oldCount {
            let amount = newCount - oldCount
            var inserted: [HoseNode] = []
            inserted.reserveCapacity(amount)

            if oldCount == 2 {
                let points = restCurvePoints(count: newCount)
                for index in 1..<(newCount - 1) {
                    inserted.append(makeNode(position: points[index]))
                }
            } else {
                let points = restCurvePoints(count: newCount)
                for index in 1...amount {
                    inserted.append(makeNode(position: points[index]))
                }
            }
            nodes.insert(contentsOf: inserted, at: 1)
        } else {
            let amount = oldCount - newCount
            nodes.removeSubrange(1..<(1 + amount))
        }

        normalizeEndpointMasses()
        orientationLambdas = Array(repeating: 0, count: nodes.count)
    }

    private mutating func makeNode(position: SIMD3<Double>) -> HoseNode {
        let node = HoseNode(
            materialID: nextMaterialID,
            position: position,
            orientation: orientationFromForward(tipPin.position - rootPin.position),
            inverseMass: 1
        )
        nextMaterialID &+= 1
        return node
    }

    private mutating func layoutInteriorAlongRestCurve() {
        let points = restCurvePoints(count: nodes.count)
        guard points.count == nodes.count else { return }
        for index in 1..<(nodes.count - 1) {
            nodes[index].position = points[index]
            nodes[index].previousPosition = points[index]
            nodes[index].orientation = orientationFromForward(
                points[index + 1] - points[index - 1]
            )
        }
        projectPins()
    }

    private func restCurvePoints(count: Int) -> [SIMD3<Double>] {
        guard count >= 2 else { return [rootPin.position] }
        let root = rootPin.position
        let tip = tipPin.position
        let endpointDelta = tip - root
        let endpointDistance = simd_length(endpointDelta)
        let rootForward = rootPin.orientation.act(SIMD3<Double>(1, 0, 0))
        let direction: SIMD3<Double>
        if endpointDistance > 1e-9 {
            direction = endpointDelta / endpointDistance
        } else if simd_length(rootForward) > 1e-9 {
            direction = simd_normalize(rootForward)
        } else {
            direction = SIMD3(1, 0, 0)
        }

        let reference = abs(direction.z) < 0.82
            ? SIMD3<Double>(0, 0, 1)
            : SIMD3<Double>(0, 1, 0)
        let lateral = simd_normalize(simd_cross(reference, direction))
        let normal = simd_normalize(simd_cross(direction, lateral))
        let slack = max(0, activeLength - endpointDistance)
        let amplitude = min(configuration.naturalSegmentLength * 0.75, slack * 0.30)
        let phases = seededPhases()
        let lengths = restSegmentLengths(for: count)
        var cumulative = 0.0
        var points: [SIMD3<Double>] = []
        points.reserveCapacity(count)

        for index in 0..<count {
            if index > 0 {
                cumulative += lengths[index - 1]
            }
            let fraction = activeLength > 1e-9
                ? min(max(cumulative / activeLength, 0), 1)
                : Double(index) / Double(count - 1)
            let envelope = sin(.pi * fraction)
            let firstWave = sin(2 * .pi * fraction + phases.0)
            let secondWave = sin(3 * .pi * fraction + phases.1)
            let offset = lateral * (amplitude * envelope * (0.72 + 0.28 * firstWave)) +
                normal * (amplitude * 0.28 * envelope * secondWave)
            points.append(root + endpointDelta * fraction + offset)
        }
        points[0] = root
        points[count - 1] = tip
        return points
    }

    private func restSegmentLengths() -> [Double] {
        restSegmentLengths(for: nodes.count)
    }

    private func restSegmentLengths(for count: Int) -> [Double] {
        guard count >= 2 else { return [] }
        let segmentCount = count - 1
        if segmentCount == 1 {
            return [max(activeLength, 1e-6)]
        }
        let fullTailLength = configuration.naturalSegmentLength * Double(segmentCount - 1)
        let reservoirSegment = max(activeLength - fullTailLength, 1e-6)
        return [reservoirSegment] + Array(
            repeating: configuration.naturalSegmentLength,
            count: segmentCount - 1
        )
    }

    private mutating func rebuildConstraints() {
        let lengths = restSegmentLengths()
        stretchConstraints = lengths.indices.map { index in
            XPBDDistanceConstraint(
                firstIndex: index,
                secondIndex: index + 1,
                restLength: lengths[index],
                compliance: configuration.stretchCompliance
            )
        }
        bendConstraints = []
        if nodes.count >= 3 {
            bendConstraints.reserveCapacity(nodes.count - 2)
            for index in 0..<(nodes.count - 2) {
                let firstLength = lengths[index]
                let secondLength = lengths[index + 1]
                let angle = seededRestBendAngle(at: index)
                let squaredChord = firstLength * firstLength + secondLength * secondLength +
                    2 * firstLength * secondLength * cos(angle)
                bendConstraints.append(
                    XPBDDistanceConstraint(
                        firstIndex: index,
                        secondIndex: index + 2,
                        restLength: sqrt(max(squaredChord, 1e-12)),
                        compliance: configuration.bendCompliance
                    )
                )
            }
        }
        orientationLambdas = Array(repeating: 0, count: nodes.count)
    }

    private mutating func integrateFreeNodes() {
        guard nodes.count > 2 else { return }
        for index in 1..<(nodes.count - 1) {
            let current = nodes[index].position
            var displacement = (current - nodes[index].previousPosition) * configuration.damping
            let length = simd_length(displacement)
            if length > configuration.maximumStepDisplacement {
                displacement *= configuration.maximumStepDisplacement / length
            }
            nodes[index].previousPosition = current
            nodes[index].position = current + displacement
        }
    }

    private mutating func solveOrientations(deltaTime: Double, iterations: Int) {
        guard nodes.count > 2 else {
            projectPins()
            return
        }
        for _ in 0..<max(2, iterations / 3) {
            for index in 1..<(nodes.count - 1) {
                let tangent = nodes[index + 1].position - nodes[index - 1].position
                guard simd_length(tangent) > 1e-10 else { continue }
                let target = orientationFromForward(tangent)
                XPBDOrientationConstraint.solve(
                    orientation: &nodes[index].orientation,
                    target: target,
                    inverseMass: nodes[index].inverseMass,
                    compliance: configuration.orientationCompliance,
                    deltaTime: deltaTime,
                    lambda: &orientationLambdas[index]
                )
                // q and -q encode the same rotation. Keep a single sign branch so
                // downstream joint interpolation cannot take a 360-degree detour.
                if simd_dot(
                    nodes[index - 1].orientation.vector,
                    nodes[index].orientation.vector
                ) < 0 {
                    nodes[index].orientation = simd_quatd(
                        vector: -nodes[index].orientation.vector
                    )
                }
            }
        }
    }

    private mutating func stabilizeVerletHistory(relativeTo oldNodes: [HoseNode]) {
        let oldByID = Dictionary(uniqueKeysWithValues: oldNodes.map { ($0.materialID, $0) })
        for index in 1..<(nodes.count - 1) {
            guard let old = oldByID[nodes[index].materialID] else {
                nodes[index].previousPosition = nodes[index].position
                continue
            }
            var velocity = nodes[index].position - old.position
            let length = simd_length(velocity)
            if length > configuration.maximumStepDisplacement {
                velocity *= configuration.maximumStepDisplacement / length
            }
            nodes[index].previousPosition = nodes[index].position - velocity * configuration.damping
        }
    }

    private mutating func normalizeEndpointMasses() {
        guard nodes.count >= 2 else { return }
        for index in nodes.indices {
            nodes[index].inverseMass = (index == 0 || index == nodes.count - 1) ? 0 : 1
        }
    }

    private mutating func projectPins() {
        guard nodes.count >= 2 else { return }
        nodes[0].position = rootPin.position
        nodes[0].orientation = rootPin.orientation
        nodes[0].inverseMass = 0
        let last = nodes.count - 1
        nodes[last].position = tipPin.position
        nodes[last].orientation = tipPin.orientation
        nodes[last].inverseMass = 0
    }

    private func allStateIsFinite() -> Bool {
        activeLength.isFinite && nodes.allSatisfy { node in
            vectorIsFinite(node.position) && vectorIsFinite(node.previousPosition) &&
                quaternionIsFinite(node.orientation) && node.inverseMass.isFinite
        }
    }

    private func seededPhases() -> (Double, Double) {
        var generator = SplitMix64(state: seed)
        return (generator.nextUnit() * 2 * .pi, generator.nextUnit() * 2 * .pi)
    }

    private func seededRestBendAngle(at index: Int) -> Double {
        let phases = seededPhases()
        let lowFrequency = sin(Double(index) * 0.31 + phases.0)
        let secondary = sin(Double(index) * 0.13 + phases.1)
        return 0.032 + 0.012 * lowFrequency + 0.006 * secondary
    }
}

private struct SplitMix64: Sendable {
    var state: UInt64

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var value = state
        value = (value ^ (value >> 30)) &* 0xBF58_476D_1CE4_E5B9
        value = (value ^ (value >> 27)) &* 0x94D0_49BB_1331_11EB
        return value ^ (value >> 31)
    }

    mutating func nextUnit() -> Double {
        Double(next() >> 11) * 0x1.0p-53
    }
}
