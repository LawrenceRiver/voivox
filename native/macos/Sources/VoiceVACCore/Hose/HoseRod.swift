import Foundation
import simd

public enum HoseSimulationFailure: Error, Equatable, Sendable {
    case invalidTimeStep
    case invalidIterationCount
    case nonFinitePin
    case invalidActiveLength
    case activeLengthOutOfRange(requested: Double, maximum: Double)
    case infeasibleSpan(span: Double, availableLength: Double)
    case infeasibleTopology(
        span: Double,
        minimumReach: Double,
        availableLength: Double,
        nodeCount: Int
    )
    case strainLimitExceeded(maximum: Double, allowed: Double)
    case angularLimitExceeded(
        maximumTemporal: Double,
        maximumAdjacent: Double,
        allowed: Double
    )
    case nonFiniteState
}

public struct HoseRod: Sendable {
    public let configuration: HoseConfiguration
    public private(set) var activeLength: Double
    public private(set) var lastFailure: HoseSimulationFailure?

    private let seed: UInt64
    private var nodes: [HoseNode]
    private var stretchConstraints: [XPBDDistanceConstraint]
    private var bendConstraints: [XPBDDistanceConstraint]
    private var orientationLambdas: [SIMD3<Double>]
    private var angularContinuityConstraints: [XPBDAngularContinuityConstraint]
    private var rootPin: (position: SIMD3<Double>, orientation: simd_quatd)
    private var tipPin: (position: SIMD3<Double>, orientation: simd_quatd)
    private var nextMaterialID: UInt64
    private var hasExplicitTipPin: Bool

    public init(configuration: HoseConfiguration, seed: UInt64) {
        self.configuration = configuration
        self.seed = seed
        lastFailure = nil
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
        orientationLambdas = [.zero, .zero]
        angularContinuityConstraints = []
        rebuildConstraints()
    }

    public var activeNodeCount: Int {
        nodes.count
    }

    public var snapshot: HoseSnapshot {
        let lengths = restSegmentLengths()
        let safeMaximum = max(configuration.maximumActiveLength, 1e-9)
        let reservoirBoundary = min(max(1 - activeLength / safeMaximum, 0), 1)
        var cumulative = 0.0
        return HoseSnapshot(
            activeLength: activeLength,
            maximumActiveLength: configuration.maximumActiveLength,
            joints: nodes.enumerated().map { index, node in
                if index > 0 {
                    cumulative += lengths[index - 1]
                }
                let activeFraction = activeLength > 1e-9
                    ? min(max(cumulative / activeLength, 0), 1)
                    : 0
                return HoseJointSample(
                    jointIndex: index,
                    materialID: node.materialID,
                    normalizedMaterialCoordinate: reservoirBoundary +
                        activeFraction * (1 - reservoirBoundary),
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
        else {
            lastFailure = .nonFinitePin
            return false
        }

        rootPin = (position, orientation)
        nodes[0].position = position
        nodes[0].previousPosition = position
        nodes[0].orientation = orientation
        nodes[0].inverseMass = 0
        lastFailure = nil
        return true
    }

    @discardableResult
    public mutating func pinTip(
        _ position: SIMD3<Double>,
        orientation: simd_quatd
    ) -> Bool {
        guard vectorIsFinite(position),
              let orientation = safeNormalizedQuaternion(orientation)
        else {
            lastFailure = .nonFinitePin
            return false
        }

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
        lastFailure = nil
        return true
    }

    @discardableResult
    public mutating func setActiveLength(_ requestedLength: Double) -> Bool {
        guard requestedLength.isFinite else {
            lastFailure = .invalidActiveLength
            return false
        }
        let clamped = min(max(requestedLength, 0), configuration.maximumActiveLength)
        guard clamped != activeLength else {
            lastFailure = nil
            return true
        }

        let span = simd_distance(rootPin.position, tipPin.position)
        let nodeCount = resolvedNodeCount(
            for: clamped,
            span: span
        ) ?? desiredNodeCount(for: clamped, currentCount: nodes.count)
        setActiveLengthUnchecked(clamped, nodeCount: nodeCount)
        lastFailure = nil
        return true
    }

    public mutating func updateDeployment(
        tipPosition: SIMD3<Double>,
        tipOrientation: simd_quatd,
        activeLength requestedLength: Double
    ) -> Result<Void, HoseSimulationFailure> {
        guard vectorIsFinite(tipPosition),
              let tipOrientation = safeNormalizedQuaternion(tipOrientation)
        else {
            lastFailure = .nonFinitePin
            return .failure(.nonFinitePin)
        }
        guard requestedLength.isFinite, requestedLength >= 0 else {
            lastFailure = .invalidActiveLength
            return .failure(.invalidActiveLength)
        }
        guard requestedLength <= configuration.maximumActiveLength else {
            let failure = HoseSimulationFailure.activeLengthOutOfRange(
                requested: requestedLength,
                maximum: configuration.maximumActiveLength
            )
            lastFailure = failure
            return .failure(failure)
        }
        let span = simd_distance(rootPin.position, tipPosition)
        guard span <= requestedLength + 1e-9 else {
            let failure = HoseSimulationFailure.infeasibleSpan(
                span: span,
                availableLength: requestedLength
            )
            lastFailure = failure
            return .failure(failure)
        }
        guard let resolvedNodeCount = resolvedNodeCount(
            for: requestedLength,
            span: span
        ) else {
            let idealCount = idealNodeCount(for: requestedLength)
            let minimumReach = topologyReachBounds(
                for: requestedLength,
                nodeCount: idealCount
            ).minimum
            let failure = HoseSimulationFailure.infeasibleTopology(
                span: span,
                minimumReach: minimumReach,
                availableLength: requestedLength,
                nodeCount: idealCount
            )
            lastFailure = failure
            return .failure(failure)
        }

        let rollback = self
        tipPin = (tipPosition, tipOrientation)
        let last = nodes.count - 1
        nodes[last].position = tipPosition
        nodes[last].previousPosition = tipPosition
        nodes[last].orientation = tipOrientation
        if requestedLength != activeLength || resolvedNodeCount != nodes.count {
            setActiveLengthUnchecked(
                requestedLength,
                nodeCount: resolvedNodeCount
            )
        } else {
            refitToRestGeometryIfNeeded()
        }
        hasExplicitTipPin = true
        projectPins()
        let allowedStrain = 0.08
        let strain = maximumSegmentStrain
        guard strain < allowedStrain else {
            let failure = HoseSimulationFailure.strainLimitExceeded(
                maximum: strain,
                allowed: allowedStrain
            )
            self = rollback
            lastFailure = failure
            return .failure(failure)
        }
        lastFailure = nil
        return .success(())
    }

    @discardableResult
    public mutating func retract(
        by amount: Double
    ) -> Result<Void, HoseSimulationFailure> {
        guard amount.isFinite, amount >= 0 else {
            lastFailure = .invalidActiveLength
            return .failure(.invalidActiveLength)
        }
        let newLength = max(activeLength - amount, 0)
        let delta = tipPin.position - rootPin.position
        let span = simd_length(delta)
        let newTip: SIMD3<Double>
        if span > newLength, span > 1e-12 {
            newTip = rootPin.position + delta / span * newLength
        } else if newLength == 0 {
            newTip = rootPin.position
        } else {
            newTip = tipPin.position
        }
        return updateDeployment(
            tipPosition: newTip,
            tipOrientation: tipPin.orientation,
            activeLength: newLength
        )
    }

    private mutating func setActiveLengthUnchecked(
        _ length: Double,
        nodeCount: Int
    ) {
        let previousCount = nodes.count
        let previousMaterialIDs = Set(nodes.map(\.materialID))
        activeLength = length
        reconcileTopology(from: previousCount, to: nodeCount)
        refitToRestGeometryIfNeeded()
        initializeNewMaterialOrientations(previousMaterialIDs: previousMaterialIDs)
        rebuildConstraints()
        projectPins()
    }

    @discardableResult
    public mutating func step(
        deltaTime: Double,
        iterations requestedIterations: Int? = nil
    ) -> Bool {
        let iterations = requestedIterations ?? configuration.solverIterations
        guard deltaTime.isFinite, deltaTime > 0, deltaTime <= 0.1 else {
            lastFailure = .invalidTimeStep
            return false
        }
        guard iterations > 0, iterations <= 256 else {
            lastFailure = .invalidIterationCount
            return false
        }
        let span = simd_distance(rootPin.position, tipPin.position)
        guard span <= activeLength + 1e-9 else {
            lastFailure = .infeasibleSpan(span: span, availableLength: activeLength)
            return false
        }
        let reach = topologyReachBounds(
            for: activeLength,
            nodeCount: nodes.count
        )
        guard span + 1e-9 >= reach.minimum else {
            lastFailure = .infeasibleTopology(
                span: span,
                minimumReach: reach.minimum,
                availableLength: activeLength,
                nodeCount: nodes.count
            )
            return false
        }

        let rollbackNodes = nodes
        let rollbackStretch = stretchConstraints
        let rollbackBend = bendConstraints
        let rollbackOrientationLambdas = orientationLambdas
        let rollbackAngularContinuity = angularContinuityConstraints

        integrateFreeNodes()
        projectPins()
        for index in stretchConstraints.indices {
            stretchConstraints[index].resetLambda()
        }
        for index in bendConstraints.indices {
            bendConstraints[index].resetLambda()
        }
        orientationLambdas = Array(repeating: .zero, count: nodes.count)

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
        let maximumTemporalAngle = clampAngularMotion(
            relativeTo: rollbackNodes,
            maximumAngle: 1.0
        )
        projectPins()
        stabilizeVerletHistory(relativeTo: rollbackNodes)

        guard allStateIsFinite() else {
            nodes = rollbackNodes
            stretchConstraints = rollbackStretch
            bendConstraints = rollbackBend
            orientationLambdas = rollbackOrientationLambdas
            angularContinuityConstraints = rollbackAngularContinuity
            lastFailure = .nonFiniteState
            return false
        }
        let allowedStrain = 0.08
        let strain = maximumSegmentStrain
        guard strain <= allowedStrain else {
            lastFailure = .strainLimitExceeded(maximum: strain, allowed: allowedStrain)
            return false
        }
        let allowedAngularChange = 1.10
        let maximumAdjacentAngle = maximumAdjacentOrientationAngle()
        guard maximumTemporalAngle <= allowedAngularChange + 1e-9,
              maximumAdjacentAngle <= allowedAngularChange + 1e-9
        else {
            lastFailure = .angularLimitExceeded(
                maximumTemporal: maximumTemporalAngle,
                maximumAdjacent: maximumAdjacentAngle,
                allowed: allowedAngularChange
            )
            return false
        }
        lastFailure = nil
        return true
    }

    private func idealNodeCount(for length: Double) -> Int {
        guard length > 0 else { return 2 }
        let segments = Int(ceil(length / configuration.naturalSegmentLength))
        return min(configuration.maximumNodeCount, max(2, segments + 1))
    }

    private func desiredNodeCount(for length: Double, currentCount: Int) -> Int {
        let ideal = idealNodeCount(for: length)
        let hysteresis = min(0.5, configuration.naturalSegmentLength * 0.02)
        if ideal > currentCount {
            let boundary = Double(currentCount - 1) * configuration.naturalSegmentLength
            if length <= boundary + hysteresis {
                return currentCount
            }
        } else if ideal < currentCount, currentCount > 2 {
            let boundary = Double(currentCount - 2) * configuration.naturalSegmentLength
            if length >= boundary - hysteresis {
                return currentCount
            }
        }
        return ideal
    }

    private func resolvedNodeCount(
        for length: Double,
        span: Double
    ) -> Int? {
        let preferred = desiredNodeCount(for: length, currentCount: nodes.count)
        if topologyCanRepresent(span: span, length: length, nodeCount: preferred) {
            return preferred
        }
        let ideal = idealNodeCount(for: length)
        if ideal != preferred,
           topologyCanRepresent(span: span, length: length, nodeCount: ideal) {
            return ideal
        }
        return nil
    }

    private func topologyCanRepresent(
        span: Double,
        length: Double,
        nodeCount: Int
    ) -> Bool {
        let bounds = topologyReachBounds(for: length, nodeCount: nodeCount)
        return span + 1e-9 >= bounds.minimum && span <= bounds.maximum + 1e-9
    }

    private func topologyReachBounds(
        for length: Double,
        nodeCount: Int
    ) -> (minimum: Double, maximum: Double) {
        let lengths = restSegmentLengths(for: nodeCount, activeLength: length)
        let maximum = lengths.reduce(0, +)
        let longest = lengths.max() ?? 0
        return (max(0, 2 * longest - maximum), maximum)
    }

    private mutating func reconcileTopology(from oldCount: Int, to newCount: Int) {
        guard oldCount != newCount else { return }

        if newCount > oldCount {
            let amount = newCount - oldCount
            let survivor = nodes[1].position
            let bridgeLengths = Array(restSegmentLengths(for: newCount).prefix(amount + 1))
            let bridge = naturalBridgePoints(
                from: rootPin.position,
                to: survivor,
                segmentLengths: bridgeLengths
            )
            let inserted = (1...amount).map { index in
                makeNode(position: bridge[index])
            }
            nodes.insert(contentsOf: inserted, at: 1)
        } else {
            let amount = oldCount - newCount
            nodes.removeSubrange(1..<(1 + amount))
        }

        normalizeEndpointMasses()
        orientationLambdas = Array(repeating: .zero, count: nodes.count)
        angularContinuityConstraints = []
    }

    /// Builds a deterministic slack bridge while keeping both existing material
    /// endpoints fixed. FABRIK makes each newly revealed bay natural at the exact
    /// instant it leaves the reservoir, so a node-count crossing cannot pop.
    private func naturalBridgePoints(
        from start: SIMD3<Double>,
        to end: SIMD3<Double>,
        segmentLengths: [Double],
        initialPoints: [SIMD3<Double>]? = nil
    ) -> [SIMD3<Double>] {
        guard !segmentLengths.isEmpty else { return [start] }
        let totalLength = segmentLengths.reduce(0, +)
        let endpointDelta = end - start
        let endpointDistance = simd_length(endpointDelta)
        guard totalLength > 1e-12 else {
            return [start] + Array(repeating: end, count: segmentLengths.count)
        }

        let forward: SIMD3<Double>
        if endpointDistance > 1e-10 {
            forward = endpointDelta / endpointDistance
        } else {
            let pinnedForward = rootPin.orientation.act(SIMD3<Double>(1, 0, 0))
            forward = simd_length(pinnedForward) > 1e-10
                ? simd_normalize(pinnedForward)
                : SIMD3<Double>(1, 0, 0)
        }
        let fallback = abs(forward.z) < 0.8
            ? SIMD3<Double>(0, 0, 1)
            : SIMD3<Double>(0, 1, 0)
        let lateral = simd_normalize(simd_cross(fallback, forward))
        let slack = max(0, totalLength - endpointDistance)

        var points: [SIMD3<Double>] = [start]
        points.reserveCapacity(segmentLengths.count + 1)
        var cumulative = 0.0
        for index in 1..<segmentLengths.count {
            cumulative += segmentLengths[index - 1]
            let materialFraction = cumulative / totalLength
            let linePoint = start + endpointDelta * materialFraction
            let phase = Double(index) * 1.618_033_988_75 + Double(seed & 0xFF) * 0.013
            let envelope = sin(.pi * materialFraction)
            let signedAmplitude = max(1, slack * 0.32) * envelope *
                (index.isMultiple(of: 2) ? 1 : -1) * (0.82 + 0.18 * sin(phase))
            points.append(linePoint + lateral * signedAmplitude)
        }
        points.append(end)

        // Reusing the current material positions gives FABRIK the closest
        // feasible solution when a pin moves. Starting every refit from the
        // decorative slack seed can mirror the whole hose across its axis,
        // which is positionally valid but creates an avoidable frame jump.
        if let initialPoints,
           initialPoints.count == points.count,
           initialPoints.allSatisfy(vectorIsFinite) {
            points = initialPoints
            points[0] = start
            points[points.count - 1] = end
        }

        func deterministicDirection(_ index: Int) -> SIMD3<Double> {
            let sign = index.isMultiple(of: 2) ? 1.0 : -1.0
            return simd_normalize(forward + lateral * (0.35 * sign))
        }

        for _ in 0..<512 {
            points[points.count - 1] = end
            for index in stride(from: segmentLengths.count - 1, through: 0, by: -1) {
                let delta = points[index] - points[index + 1]
                let direction = simd_length(delta) > 1e-12
                    ? delta / simd_length(delta)
                    : -deterministicDirection(index)
                points[index] = points[index + 1] + direction * segmentLengths[index]
            }

            points[0] = start
            for index in segmentLengths.indices {
                let delta = points[index + 1] - points[index]
                let direction = simd_length(delta) > 1e-12
                    ? delta / simd_length(delta)
                    : deterministicDirection(index)
                points[index + 1] = points[index] + direction * segmentLengths[index]
            }
            if simd_distance(points.last!, end) < 1e-9 { break }
        }
        points[0] = start
        points[points.count - 1] = end
        return points
    }

    private mutating func makeNode(position: SIMD3<Double>) -> HoseNode {
        let node = HoseNode(
            materialID: nextMaterialID,
            position: position,
            orientation: rootPin.orientation,
            inverseMass: 1
        )
        nextMaterialID &+= 1
        return node
    }

    private mutating func initializeNewMaterialOrientations(
        previousMaterialIDs: Set<UInt64>
    ) {
        guard nodes.count > 2 else { return }
        let lengths = restSegmentLengths()
        var cumulative = 0.0
        for index in 1..<(nodes.count - 1) {
            cumulative += lengths[index - 1]
            guard !previousMaterialIDs.contains(nodes[index].materialID) else { continue }
            let fraction = activeLength > 1e-9
                ? min(max(cumulative / activeLength, 0), 1)
                : Double(index) / Double(nodes.count - 1)
            nodes[index].orientation = hemisphereSlerp(
                rootPin.orientation,
                tipPin.orientation,
                fraction: fraction
            )
        }
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
        restSegmentLengths(for: nodes.count, activeLength: activeLength)
    }

    private func restSegmentLengths(for count: Int) -> [Double] {
        restSegmentLengths(for: count, activeLength: activeLength)
    }

    private func restSegmentLengths(
        for count: Int,
        activeLength length: Double
    ) -> [Double] {
        guard count >= 2 else { return [] }
        let segmentCount = count - 1
        guard length > 0 else {
            return Array(repeating: 0, count: segmentCount)
        }
        let epsilon = min(1e-6, length / Double(segmentCount * 1_024))
        var lengths = Array(repeating: epsilon, count: segmentCount)
        var remaining = max(0, length - epsilon * Double(segmentCount))
        for index in stride(from: segmentCount - 1, through: 0, by: -1) {
            let capacity = configuration.naturalSegmentLength - lengths[index]
            let addition = min(max(0, capacity), remaining)
            lengths[index] += addition
            remaining -= addition
        }
        // Hysteresis may retain one fewer node for a sub-point interval. Keep the
        // exact material sum by allowing only the root reservoir bay to absorb it.
        if remaining > 0 {
            lengths[0] += remaining
        }
        return lengths
    }

    private mutating func refitToRestGeometryIfNeeded() {
        guard nodes.count > 2, maximumSegmentStrain >= 0.08 else { return }
        let lengths = restSegmentLengths()
        let span = simd_distance(rootPin.position, tipPin.position)
        guard topologyCanRepresent(
            span: span,
            length: activeLength,
            nodeCount: nodes.count
        ) else { return }
        let points = naturalBridgePoints(
            from: rootPin.position,
            to: tipPin.position,
            segmentLengths: lengths,
            initialPoints: nodes.map(\.position)
        )
        guard points.count == nodes.count else { return }
        for index in 1..<(nodes.count - 1) {
            nodes[index].position = points[index]
            nodes[index].previousPosition = points[index]
        }
        projectPins()
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
        orientationLambdas = Array(repeating: .zero, count: nodes.count)
        angularContinuityConstraints = []
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
        let targets = transportedMaterialFrames()
        orientationLambdas = Array(repeating: .zero, count: nodes.count)
        angularContinuityConstraints = (0..<(nodes.count - 1)).map { index in
            XPBDAngularContinuityConstraint(
                firstIndex: index,
                secondIndex: index + 1,
                restRelativeOrientation: normalizedQuaternion(
                    targets[index + 1] * targets[index].inverse
                ),
                compliance: configuration.orientationCompliance
            )
        }

        let angularIterations = max(4, iterations / 2)
        for _ in 0..<angularIterations {
            for index in angularContinuityConstraints.indices {
                angularContinuityConstraints[index].solve(
                    nodes: &nodes,
                    deltaTime: deltaTime,
                    maximumCorrection: 0.24
                )
            }
            for index in 1..<(nodes.count - 1) {
                XPBDVectorAngularConstraint.solveTarget(
                    orientation: &nodes[index].orientation,
                    target: targets[index],
                    inverseMass: nodes[index].inverseMass,
                    compliance: configuration.orientationCompliance,
                    deltaTime: deltaTime,
                    lambda: &orientationLambdas[index],
                    maximumCorrection: 0.30
                )
            }
            projectPins()
        }

        for index in 1..<(nodes.count - 1) {
            nodes[index].orientation = hemisphereSlerp(
                nodes[index].orientation,
                targets[index],
                fraction: 0.98
            )
            if simd_dot(
                nodes[index - 1].orientation.vector,
                nodes[index].orientation.vector
            ) < 0 {
                nodes[index].orientation = simd_quatd(
                    vector: -nodes[index].orientation.vector
                )
            }
        }
        projectPins()
    }

    /// Builds a Bishop (parallel-transport) frame field and distributes the
    /// nozzle's explicit local-X twist before projecting the full endpoint swing
    /// into a bounded spatial frame chain.
    private func transportedMaterialFrames() -> [simd_quatd] {
        guard nodes.count >= 2 else { return nodes.map(\.orientation) }
        var tangents: [SIMD3<Double>] = []
        tangents.reserveCapacity(nodes.count)
        for index in nodes.indices {
            let delta: SIMD3<Double>
            if index == 0 {
                delta = nodes[1].position - nodes[0].position
            } else if index == nodes.count - 1 {
                delta = nodes[index].position - nodes[index - 1].position
            } else {
                delta = nodes[index + 1].position - nodes[index - 1].position
            }
            if vectorIsFinite(delta), simd_length(delta) > 1e-10 {
                tangents.append(simd_normalize(delta))
            } else if let previous = tangents.last {
                tangents.append(previous)
            } else {
                tangents.append(rootPin.orientation.act(SIMD3<Double>(1, 0, 0)))
            }
        }

        var transported = Array(repeating: simd_quatd.identity, count: nodes.count)
        transported[0] = rootPin.orientation
        var previousDirection = rootPin.orientation.act(SIMD3<Double>(1, 0, 0))
        if simd_length(previousDirection) < 1e-10 {
            previousDirection = tangents[0]
        } else {
            previousDirection = simd_normalize(previousDirection)
        }
        for index in 1..<nodes.count {
            let previousFrame = transported[index - 1]
            let rotation = minimalRotation(
                from: previousDirection,
                to: tangents[index],
                preferredAxis: previousFrame.act(SIMD3<Double>(0, 1, 0))
            )
            transported[index] = normalizedQuaternion(rotation * previousFrame)
            previousDirection = tangents[index]
        }

        let localDifference = normalizedQuaternion(
            transported.last!.inverse * tipPin.orientation
        )
        let localTwistCandidate = simd_quatd(
            ix: localDifference.imag.x,
            iy: 0,
            iz: 0,
            r: localDifference.real
        )
        let localTwist = safeNormalizedQuaternion(localTwistCandidate) ?? .identity
        let lengths = restSegmentLengths()
        var cumulative = 0.0
        var targets = transported
        for index in 1..<(nodes.count - 1) {
            cumulative += lengths[index - 1]
            let fraction = activeLength > 1e-9
                ? min(max(cumulative / activeLength, 0), 1)
                : Double(index) / Double(nodes.count - 1)
            targets[index] = normalizedQuaternion(
                transported[index] * hemisphereSlerp(
                    .identity,
                    localTwist,
                    fraction: fraction
                )
            )
        }
        targets[0] = rootPin.orientation
        targets[nodes.count - 1] = tipPin.orientation
        targets = boundedFrameField(
            targets,
            tangents: tangents,
            maximumAdjacentAngle: 0.26
        )
        for index in 1..<(targets.count - 1) where
            simd_dot(targets[index - 1].vector, targets[index].vector) < 0 {
            targets[index] = simd_quatd(vector: -targets[index].vector)
        }
        return targets
    }

    private func boundedFrameField(
        _ input: [simd_quatd],
        tangents: [SIMD3<Double>],
        maximumAdjacentAngle: Double
    ) -> [simd_quatd] {
        guard input.count > 2 else { return input }
        var frames = input
        let last = frames.count - 1
        let tipForward = tipPin.orientation.act(SIMD3<Double>(1, 0, 0))
        let tipTracksCenterline = simd_dot(
            simd_normalize(tipForward),
            simd_normalize(tangents[last])
        ) > 0.95

        func bounded(
            from anchor: simd_quatd,
            toward candidate: simd_quatd,
            limit: Double
        ) -> simd_quatd {
            let angle = orientationAngle(anchor, candidate)
            guard angle > limit else { return candidate }
            return hemisphereSlerp(
                anchor,
                candidate,
                fraction: limit / angle
            )
        }

        frames[0] = rootPin.orientation
        for index in 1..<last {
            frames[index] = bounded(
                from: frames[index - 1],
                toward: frames[index],
                limit: maximumAdjacentAngle
            )
        }

        // Large endpoint swing is allowed a looser one-radian spatial envelope;
        // aligned swivel retains the close 0.26-radian corrugation continuity.
        let spatialLimit = tipTracksCenterline ? maximumAdjacentAngle : 1.0
        for _ in 0..<32 {
            frames[0] = rootPin.orientation
            for index in 1..<last {
                frames[index] = bounded(
                    from: frames[index - 1],
                    toward: frames[index],
                    limit: spatialLimit
                )
            }
            frames[last] = tipPin.orientation
            for index in stride(from: last - 1, through: 1, by: -1) {
                frames[index] = bounded(
                    from: frames[index + 1],
                    toward: frames[index],
                    limit: spatialLimit
                )
            }
            let maximum = zip(frames, frames.dropFirst()).reduce(0.0) {
                max($0, orientationAngle($1.0, $1.1))
            }
            if maximum <= spatialLimit + 1e-9 { break }
        }
        frames[0] = rootPin.orientation
        frames[last] = tipPin.orientation
        return frames
    }

    private mutating func clampAngularMotion(
        relativeTo previousNodes: [HoseNode],
        maximumAngle: Double
    ) -> Double {
        guard nodes.count > 2 else { return 0 }
        let previousByID = Dictionary(
            uniqueKeysWithValues: previousNodes.map { ($0.materialID, $0.orientation) }
        )
        var observedMaximum = 0.0
        for index in 1..<(nodes.count - 1) {
            guard let previous = previousByID[nodes[index].materialID] else { continue }
            let angle = orientationAngle(previous, nodes[index].orientation)
            if angle > maximumAngle {
                nodes[index].orientation = hemisphereSlerp(
                    previous,
                    nodes[index].orientation,
                    fraction: maximumAngle / angle
                )
            }
            observedMaximum = max(
                observedMaximum,
                orientationAngle(previous, nodes[index].orientation)
            )
        }
        return observedMaximum
    }

    private func maximumAdjacentOrientationAngle() -> Double {
        zip(nodes, nodes.dropFirst()).reduce(0) { maximum, pair in
            max(maximum, orientationAngle(pair.0.orientation, pair.1.orientation))
        }
    }

    private func orientationAngle(
        _ first: simd_quatd,
        _ second: simd_quatd
    ) -> Double {
        let dot = abs(simd_dot(first.vector, second.vector))
        return 2 * acos(max(-1, min(1, dot)))
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
