import Foundation
import simd
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC active-length hose")
struct HoseRodTests {
    private let step = 1.0 / 120.0

    @Test("deployment reveals natural-length nodes instead of stretching a short rod")
    func activeLengthDeployment() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 42)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.pinTip(SIMD3(480, 0, 0), orientation: .identity))
        expectSuccess(rod.setActiveLength(500))

        for _ in 0..<180 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }

        #expect(rod.activeNodeCount > 10)
        #expect(rod.maximumSegmentStrain < 0.08)
    }

    @Test("deployment is capped at 72 nodes and spans the full-screen diagonal")
    func fullScreenDeployment() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 7)
        let tip = SIMD3<Double>(2_100, 620, 0)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.pinTip(tip, orientation: .identity))
        expectSuccess(rod.setActiveLength(2_200))

        for _ in 0..<240 {
            expectSuccess(rod.step(deltaTime: step, iterations: 24))
        }

        #expect(rod.activeLength >= 2_200)
        #expect(rod.activeNodeCount <= 72)
        let allJointsAreFinite = rod.snapshot.joints.allSatisfy { $0.isFinite }
        #expect(allJointsAreFinite)
        #expect(rod.maximumSegmentStrain < 0.08)
        let measuredLength = zip(
            rod.snapshot.joints,
            rod.snapshot.joints.dropFirst()
        ).reduce(0.0) { partial, pair in
            partial + simd_distance(pair.0.position, pair.1.position)
        }
        #expect(abs(measuredLength / rod.activeLength - 1) < 0.08)

        expectSuccess(rod.setActiveLength(100_000))
        #expect(rod.activeNodeCount == 72)
        #expect(rod.activeLength == HoseConfiguration.voiceVAC.maximumActiveLength)
    }

    @Test("interior orientations are normalized continuous centerline frames")
    func centerlineOrientations() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 55)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.pinTip(SIMD3(780, 210, 35), orientation: .identity))
        expectSuccess(rod.setActiveLength(900))
        for _ in 0..<180 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }

        let joints = rod.snapshot.joints
        for index in 1..<(joints.count - 1) {
            let joint = joints[index]
            let tangent = simd_normalize(
                joints[index + 1].position - joints[index - 1].position
            )
            let frameForward = joint.orientation.act(SIMD3<Double>(1, 0, 0))
            #expect(abs(simd_length(joint.orientation.vector) - 1) < 1e-10)
            #expect(simd_dot(frameForward, tangent) > 0.95)

            if index + 1 < joints.count - 1 {
                let neighborDot = simd_dot(
                    joint.orientation.vector,
                    joints[index + 1].orientation.vector
                )
                #expect(neighborDot > 0)
            }
        }
    }

    @Test("root and tip position and orientation remain hard pinned")
    func hardPins() {
        let rootOrientation = simd_quatd(
            angle: .pi / 8,
            axis: SIMD3<Double>(0, 0, 1)
        )
        let tipOrientation = simd_quatd(
            angle: -.pi / 5,
            axis: SIMD3<Double>(0, 1, 0)
        )
        let root = SIMD3<Double>(37, -21, 4)
        let tip = SIMD3<Double>(680, 190, -15)
        var rod = HoseRod(configuration: .voiceVAC, seed: 100)

        expectSuccess(rod.pinRoot(root, orientation: rootOrientation))
        expectSuccess(rod.pinTip(tip, orientation: tipOrientation))
        expectSuccess(rod.setActiveLength(760))
        for _ in 0..<120 {
            expectSuccess(rod.step(deltaTime: step, iterations: 18))
        }

        let joints = rod.snapshot.joints
        #expect(joints.first?.position == root)
        #expect(joints.last?.position == tip)
        #expect(quaternionDistance(joints.first?.orientation, rootOrientation) < 1e-12)
        #expect(quaternionDistance(joints.last?.orientation, tipOrientation) < 1e-12)
    }

    @Test("same seed commands and timestep produce identical snapshots")
    func deterministicSnapshots() {
        var first = HoseRod(configuration: .voiceVAC, seed: 0xCAFE_BABE)
        var second = HoseRod(configuration: .voiceVAC, seed: 0xCAFE_BABE)

        for index in 0..<180 {
            let phase = Double(index) * 0.03125
            let tip = SIMD3<Double>(820 + sin(phase) * 32, 180 + cos(phase) * 24, 0)
            for _ in 0..<1 {
                expectSuccess(first.pinRoot(.zero, orientation: .identity))
                expectSuccess(first.pinTip(tip, orientation: .identity))
                expectSuccess(first.setActiveLength(940))
                expectSuccess(first.step(deltaTime: step, iterations: 16))

                expectSuccess(second.pinRoot(.zero, orientation: .identity))
                expectSuccess(second.pinTip(tip, orientation: .identity))
                expectSuccess(second.setActiveLength(940))
                expectSuccess(second.step(deltaTime: step, iterations: 16))
            }
        }

        #expect(first.snapshot == second.snapshot)
        #expect(first.maximumSegmentStrain == second.maximumSegmentStrain)
    }

    @Test("different fixed seeds produce different gentle rest curvature safely")
    func seededRestCurvature() {
        var first = HoseRod(configuration: .voiceVAC, seed: 1)
        var second = HoseRod(configuration: .voiceVAC, seed: 2)
        for index in 0..<2 {
            if index == 0 {
                expectSuccess(first.pinRoot(.zero, orientation: .identity))
                expectSuccess(first.pinTip(SIMD3(720, 0, 0), orientation: .identity))
                expectSuccess(first.setActiveLength(800))
            } else {
                expectSuccess(second.pinRoot(.zero, orientation: .identity))
                expectSuccess(second.pinTip(SIMD3(720, 0, 0), orientation: .identity))
                expectSuccess(second.setActiveLength(800))
            }
        }

        for _ in 0..<180 {
            expectSuccess(first.step(deltaTime: step, iterations: 18))
            expectSuccess(second.step(deltaTime: step, iterations: 18))
        }

        #expect(first.snapshot.joints.map(\.position) != second.snapshot.joints.map(\.position))
        #expect(first.maximumSegmentStrain < 0.08)
        #expect(second.maximumSegmentStrain < 0.08)
        #expect(first.activeNodeCount == second.activeNodeCount)
    }

    @Test("600 fixed frames stay finite bounded and low-strain")
    func sixHundredFrameStability() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 42)
        expectSuccess(rod.pinRoot(SIMD3(40, 80, 0), orientation: .identity))
        expectSuccess(rod.setActiveLength(1_600))

        var maximumObservedStrain = 0.0
        var finite = true
        for frame in 0..<600 {
            let t = Double(frame) * step
            let tip = SIMD3<Double>(
                1_310 + sin(t * 2.3) * 90,
                470 + cos(t * 1.7) * 120,
                sin(t * 0.7) * 16
            )
            expectSuccess(rod.pinTip(tip, orientation: .identity))
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
            maximumObservedStrain = max(maximumObservedStrain, rod.maximumSegmentStrain)
            finite = finite && rod.snapshot.joints.allSatisfy(\.isFinite)
        }

        print(
            "VOICEVAC_STABILITY frames=600 finite=\(finite) " +
            "nodes=\(rod.activeNodeCount) activeLength=\(rod.activeLength) " +
            "maxStrain=\(maximumObservedStrain)"
        )
        #expect(finite)
        #expect(maximumObservedStrain < 0.08)
        #expect(rod.activeNodeCount <= 72)
        #expect(rod.maximumDistanceFromRoot < 3_200)
        #expect(rod.maximumSegmentStrain < 0.08)
    }

    @Test("an abrupt pointer turn remains finite and inside the safety bound")
    func abruptTipTurn() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 88)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.setActiveLength(1_300))
        let targets: [SIMD3<Double>] = [
            SIMD3(1_050, 120, 0),
            SIMD3(-720, 740, 0),
            SIMD3(620, -820, 40),
            SIMD3(-980, -110, -25),
            SIMD3(940, 340, 0)
        ]

        for target in targets {
            expectSuccess(rod.pinTip(target, orientation: .identity))
            for _ in 0..<18 {
                let succeeded = rod.step(deltaTime: step, iterations: 24)
                #expect(succeeded || rod.lastFailure != nil)
                if succeeded {
                    #expect(rod.maximumSegmentStrain < 0.08)
                }
                let transientIsFinite = rod.snapshot.joints.allSatisfy { $0.isFinite }
                #expect(transientIsFinite)
                #expect(rod.maximumDistanceFromRoot < 4_000)
            }
            let allJointsAreFinite = rod.snapshot.joints.allSatisfy { $0.isFinite }
            #expect(allJointsAreFinite)
            #expect(rod.maximumDistanceFromRoot < 4_000)
            #expect(rod.maximumSegmentStrain < 0.50)
        }
    }

    @Test("retraction removes reservoir nodes monotonically while retaining material identity")
    func monotonicRetraction() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 42)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.pinTip(SIMD3(620, 80, 0), orientation: .identity))
        expectSuccess(rod.setActiveLength(800))
        for _ in 0..<60 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }

        var previousLength = rod.activeLength
        var previousCount = rod.activeNodeCount
        for amount in [37.0, 95.0, 210.0, 600.0] {
            let beforeMaterial = Set(rod.snapshot.joints.map(\.materialID))
            expectDeploymentSuccess(rod.retract(by: amount))
            let after = rod.snapshot

            #expect(rod.activeLength <= previousLength)
            #expect(rod.activeLength >= 0)
            #expect(rod.activeNodeCount <= previousCount)
            #expect(Set(after.joints.map(\.materialID)).isSubset(of: beforeMaterial))
            #expect(rod.maximumSegmentStrain < 0.08)
            previousLength = rod.activeLength
            previousCount = rod.activeNodeCount
        }
    }

    @Test("snapshot is root-to-tip with immutable stable joint indices")
    func snapshotContract() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 9)
        expectSuccess(rod.pinRoot(SIMD3(10, 20, 0), orientation: .identity))
        expectSuccess(rod.pinTip(SIMD3(400, 110, 0), orientation: .identity))
        expectSuccess(rod.setActiveLength(460))
        let before = rod.snapshot

        #expect(before.joints.map(\.jointIndex) == Array(before.joints.indices))
        #expect(Set(before.joints.map(\.materialID)).count == before.joints.count)
        #expect(before.joints.first?.position == SIMD3(10, 20, 0))
        #expect(before.joints.last?.position == SIMD3(400, 110, 0))

        expectSuccess(rod.pinTip(SIMD3(410, 130, 0), orientation: .identity))
        expectSuccess(rod.step(deltaTime: step, iterations: 12))
        #expect(before != rod.snapshot)
        #expect(before.joints.first?.position == SIMD3(10, 20, 0))
        #expect(before.joints.last?.position == SIMD3(400, 110, 0))
    }

    @Test("invalid configuration is rejected before a rod can exist")
    func invalidConfiguration() {
        #expect(throws: HoseConfigurationError.self) {
            try HoseConfiguration(
                maximumNodeCount: 1,
                naturalSegmentLength: 0,
                maximumActiveLength: -1,
                stretchCompliance: -.infinity,
                bendCompliance: -.nan,
                orientationCompliance: -1,
                damping: 2,
                solverIterations: 0,
                maximumStepDisplacement: 0
            )
        }
    }

    @Test("configuration cannot exceed the renderer's 72-joint safety cap")
    func configurationNodeCap() {
        #expect(throws: HoseConfigurationError.self) {
            try HoseConfiguration(
                maximumNodeCount: 73,
                naturalSegmentLength: 32,
                maximumActiveLength: 2_200,
                stretchCompliance: 0,
                bendCompliance: 0,
                orientationCompliance: 0,
                damping: 0.9,
                solverIterations: 12,
                maximumStepDisplacement: 160
            )
        }
    }

    @Test("configuration rejects a maximum active length shorter than one bay")
    func configurationMinimumReach() {
        #expect(throws: HoseConfigurationError.self) {
            try HoseConfiguration(
                maximumNodeCount: 72,
                naturalSegmentLength: 40,
                maximumActiveLength: 39,
                stretchCompliance: 0,
                bendCompliance: 1e-5,
                orientationCompliance: 1e-6,
                damping: 0.9,
                solverIterations: 12,
                maximumStepDisplacement: 160
            )
        }
    }

    @Test("Voice VAC reach derives from display diagonal with 8 percent reserve")
    func dynamicVoiceVACReach() throws {
        let compatibility = HoseConfiguration.voiceVAC
        let wideDisplay = try HoseConfiguration.voiceVAC(requiredDisplayDiagonal: 3_000)

        #expect(compatibility.maximumActiveLength >= 2_376)
        #expect(wideDisplay.maximumActiveLength >= 3_240)
        #expect(wideDisplay.maximumNodeCount == 72)
        #expect(
            abs(
                wideDisplay.naturalSegmentLength *
                    Double(wideDisplay.maximumNodeCount - 1) -
                    wideDisplay.maximumActiveLength
            ) < 1e-9
        )
        #expect(compatibility.stretchCompliance < compatibility.orientationCompliance)
        #expect(compatibility.orientationCompliance < compatibility.bendCompliance)
    }

    @Test("atomic deployment rejects an infeasible span without partial mutation")
    func atomicDeploymentFeasibility() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 22)
        let before = rod.snapshot

        let rejected = rod.updateDeployment(
            tipPosition: SIMD3(900, 0, 0),
            tipOrientation: .identity,
            activeLength: 500
        )
        guard case let .failure(.infeasibleSpan(span, availableLength)) = rejected else {
            Issue.record("Expected an infeasible-span result")
            return
        }
        #expect(span == 900)
        #expect(availableLength == 500)
        #expect(rod.snapshot == before)

        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(820, 120, 0),
                tipOrientation: .identity,
                activeLength: 940
            )
        )
        #expect(rod.activeLength == 940)
        #expect(rod.snapshot.joints.last?.position == SIMD3(820, 120, 0))
    }

    @Test("pending legacy pins fail observably when their span exceeds material")
    func legacyPendingInfeasibility() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 33)
        expectSuccess(rod.pinRoot(.zero, orientation: .identity))
        expectSuccess(rod.pinTip(SIMD3(1_200, 0, 0), orientation: .identity))
        expectSuccess(rod.setActiveLength(500))

        expectFailure(rod.step(deltaTime: step, iterations: 20))
        guard case let .infeasibleSpan(span, availableLength) = rod.lastFailure else {
            Issue.record("Expected typed infeasible-span failure")
            return
        }
        #expect(span == 1_200)
        #expect(availableLength == 500)
        #expect(rod.maximumSegmentStrain > 0.08)
    }

    @Test("retraction moves the tip atomically once slack is exhausted")
    func feasibleAtomicRetraction() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 44)
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(700, 0, 0),
                tipOrientation: .identity,
                activeLength: 800
            )
        )

        expectDeploymentSuccess(rod.retract(by: 250))
        #expect(rod.activeLength == 550)
        #expect(simd_distance(rod.snapshot.joints.first!.position, rod.snapshot.joints.last!.position) <= 550)
        #expect(rod.lastFailure == nil)
    }

    @Test("reservoir topology crossings preserve survivors and natural edge strain")
    func topologyCrossingHasNoPop() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 66)
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(420, 0, 0),
                tipOrientation: .identity,
                activeLength: 500
            )
        )
        for _ in 0..<120 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }

        for targetLength in [532.0, 700.0] {
            let before = Dictionary(
                uniqueKeysWithValues: rod.snapshot.joints.map { ($0.materialID, $0.position) }
            )
            expectDeploymentSuccess(
                rod.updateDeployment(
                    tipPosition: SIMD3(420, 0, 0),
                    tipOrientation: .identity,
                    activeLength: targetLength
                )
            )

            #expect(rod.maximumSegmentStrain < 0.08)
            for joint in rod.snapshot.joints.dropFirst().dropLast() {
                if let previous = before[joint.materialID] {
                    #expect(simd_distance(joint.position, previous) < 1e-9)
                }
            }
        }
    }

    @Test("same-topology active-length changes refit the reservoir without strain")
    func sameTopologyLengthChangeHasNoPop() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 67)
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(420, 0, 0),
                tipOrientation: .identity,
                activeLength: 500
            )
        )
        for _ in 0..<120 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }
        let nodeCount = rod.activeNodeCount

        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(420, 0, 0),
                tipOrientation: .identity,
                activeLength: 490
            )
        )

        #expect(rod.activeNodeCount == nodeCount)
        #expect(rod.maximumSegmentStrain < 0.08)
    }

    @Test("same-length tip moves refit or reject before reporting atomic success")
    func sameLengthTipMovesStaySafe() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 68)
        let activeLength = 39.6
        for tipX in [30.0, 32.0, 34.0, 36.0] {
            let before = rod.snapshot
            let result = rod.updateDeployment(
                tipPosition: SIMD3(tipX, 0, 0),
                tipOrientation: .identity,
                activeLength: activeLength
            )
            switch result {
            case .success:
                #expect(rod.maximumSegmentStrain < 0.08)
            case .failure(.strainLimitExceeded):
                #expect(rod.snapshot == before)
            case let .failure(failure):
                Issue.record("Unexpected deployment failure: \(failure)")
            }
        }
    }

    @Test("topology hysteresis prevents node churn around a bay boundary")
    func topologyBoundaryHysteresis() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 77)
        let boundary = rod.configuration.naturalSegmentLength * 15
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(boundary * 0.8, 0, 0),
                tipOrientation: .identity,
                activeLength: boundary - 0.2
            )
        )
        let stableCount = rod.activeNodeCount

        for length in [boundary + 0.2, boundary - 0.2, boundary + 0.1, boundary - 0.1] {
            expectDeploymentSuccess(
                rod.updateDeployment(
                    tipPosition: SIMD3(boundary * 0.8, 0, 0),
                    tipOrientation: .identity,
                    activeLength: length
                )
            )
            #expect(rod.activeNodeCount == stableCount)
            #expect(rod.maximumSegmentStrain < 0.08)
        }

        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(boundary * 0.8, 0, 0),
                tipOrientation: .identity,
                activeLength: boundary + 1
            )
        )
        let upperCount = rod.activeNodeCount
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(boundary * 0.8, 0, 0),
                tipOrientation: .identity,
                activeLength: boundary - 0.2
            )
        )
        #expect(rod.activeNodeCount == upperCount)
        #expect(rod.maximumSegmentStrain < 0.08)
    }

    @Test("atomic deployment rejects a span below the selected topology minimum reach")
    func atomicDeploymentRejectsUnrepresentableTopology() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 78)
        let before = rod.snapshot
        let requestedLength = rod.configuration.naturalSegmentLength + 0.5

        let result = rod.updateDeployment(
            tipPosition: .zero,
            tipOrientation: .identity,
            activeLength: requestedLength
        )

        guard case let .failure(
            .infeasibleTopology(span, minimumReach, availableLength, nodeCount)
        ) = result else {
            Issue.record("Expected typed topology infeasibility, got \(result)")
            return
        }
        #expect(span == 0)
        #expect(minimumReach > 0)
        #expect(availableLength == requestedLength)
        #expect(nodeCount >= 2)
        #expect(rod.snapshot == before)
    }

    @Test("parallel-transport frames cross negative X without quaternion flips")
    func framesCrossNegativeXContinuously() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 99)
        var previousByMaterial: [UInt64: simd_quatd] = [:]
        let angles = stride(from: 0.75 * Double.pi, through: 1.25 * .pi, by: .pi / 48)

        for angle in angles {
            let direction = SIMD3<Double>(cos(angle), sin(angle), 0)
            let tip = direction * 720
            expectDeploymentSuccess(
                rod.updateDeployment(
                    tipPosition: tip,
                    tipOrientation: testFrame(forward: direction, roll: 0),
                    activeLength: 900
                )
            )
            expectSuccess(rod.step(deltaTime: step, iterations: 24))
            let joints = rod.snapshot.joints

            for joint in joints.dropFirst().dropLast() {
                #expect(abs(simd_length(joint.orientation.vector) - 1) < 1e-10)
                if let previous = previousByMaterial[joint.materialID] {
                    #expect(quaternionGeodesic(previous, joint.orientation) < 1.10)
                }
                previousByMaterial[joint.materialID] = joint.orientation
            }
            for pair in zip(joints.dropFirst(), joints.dropFirst(2)) {
                #expect(quaternionGeodesic(pair.0.orientation, pair.1.orientation) < 1.10)
            }
        }
    }

    @Test("tip roll is distributed smoothly while endpoint frames remain exact")
    func controlledTipRoll() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 111)
        let tipOrientation = testFrame(
            forward: SIMD3(1, 0, 0),
            roll: .pi / 2
        )
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(720, 0, 0),
                tipOrientation: tipOrientation,
                activeLength: 800
            )
        )
        for _ in 0..<240 {
            expectSuccess(rod.step(deltaTime: step, iterations: 24))
        }

        let joints = rod.snapshot.joints
        #expect(quaternionGeodesic(joints.first!.orientation, .identity) < 1e-12)
        #expect(quaternionGeodesic(joints.last!.orientation, tipOrientation) < 1e-12)
        var previousRoll = -Double.infinity
        for joint in joints {
            let yAxis = joint.orientation.act(SIMD3<Double>(0, 1, 0))
            let roll = atan2(yAxis.z, yAxis.y)
            #expect(roll + 0.05 >= previousRoll)
            previousRoll = roll
        }
        for pair in zip(joints, joints.dropFirst()) {
            #expect(quaternionGeodesic(pair.0.orientation, pair.1.orientation) < 0.30)
        }
    }

    @Test("abrupt tip swing is rate-limited and cannot report unsafe success")
    func abruptTipSwingIsRateLimited() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 112)
        let tip = SIMD3<Double>(720, 0, 0)
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: tip,
                tipOrientation: .identity,
                activeLength: 800
            )
        )
        for _ in 0..<120 {
            expectSuccess(rod.step(deltaTime: step, iterations: 24))
        }
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: tip,
                tipOrientation: simd_quatd(
                    angle: .pi,
                    axis: SIMD3<Double>(0, 1, 0)
                ),
                activeLength: 800
            )
        )

        var eventuallySucceeded = false
        var sawTypedFailure = false
        for _ in 0..<8 {
            let before = Dictionary(
                uniqueKeysWithValues: rod.snapshot.joints.map {
                    ($0.materialID, $0.orientation)
                }
            )
            let succeeded = rod.step(deltaTime: step, iterations: 24)
            let after = rod.snapshot.joints
            for joint in after.dropFirst().dropLast() {
                if let previous = before[joint.materialID] {
                    #expect(quaternionGeodesic(previous, joint.orientation) <= 1.10)
                }
            }

            let maximumAdjacent = zip(after, after.dropFirst()).reduce(0.0) {
                max($0, quaternionGeodesic($1.0.orientation, $1.1.orientation))
            }
            if succeeded {
                #expect(maximumAdjacent <= 1.10)
                eventuallySucceeded = true
                break
            }
            guard case .angularLimitExceeded = rod.lastFailure else {
                Issue.record("Expected typed angular failure, got \(String(describing: rod.lastFailure))")
                break
            }
            sawTypedFailure = true
        }
        #expect(sawTypedFailure)
        #expect(eventuallySucceeded)
        #expect(
            quaternionGeodesic(
                rod.snapshot.joints.last!.orientation,
                simd_quatd(angle: .pi, axis: SIMD3<Double>(0, 1, 0))
            ) < 1e-12
        )
    }

    @Test("snapshot maps deterministically to exactly 64 rig joints")
    func fixedRigMapping() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 123)
        expectDeploymentSuccess(
            rod.updateDeployment(
                tipPosition: SIMD3(640, 80, 0),
                tipOrientation: testFrame(forward: SIMD3(8, 1, 0), roll: 0.4),
                activeLength: 760
            )
        )
        for _ in 0..<120 {
            expectSuccess(rod.step(deltaTime: step, iterations: 20))
        }

        let first = rod.snapshot.fixedRigSnapshot()
        let second = rod.snapshot.fixedRigSnapshot()
        #expect(first == second)
        #expect(first.joints.count == 64)
        #expect(first.joints.map(\.rigIndex) == Array(0..<64))
        #expect(first.joints.first?.normalizedMaterialCoordinate == 0)
        #expect(first.joints.last?.normalizedMaterialCoordinate == 1)
        #expect(first.joints.first?.position == rod.snapshot.joints.first?.position)
        #expect(first.joints.last?.position == rod.snapshot.joints.last?.position)
        #expect(first.joints.contains { $0.activity == .inactiveReservoir })
        #expect(first.joints.contains { $0.activity == .active })
        for pair in zip(first.joints, first.joints.dropFirst()) {
            #expect(simd_dot(pair.0.orientation.vector, pair.1.orientation.vector) >= 0)
        }
    }

    @Test("rig interpolation hemisphere-corrects equivalent quaternion signs")
    func rigQuaternionHemisphereCorrection() {
        let identity = simd_quatd.identity
        let snapshot = HoseSnapshot(
            activeLength: 100,
            maximumActiveLength: 100,
            joints: [
                HoseJointSample(
                    jointIndex: 0,
                    materialID: 0,
                    normalizedMaterialCoordinate: 0,
                    position: .zero,
                    orientation: identity
                ),
                HoseJointSample(
                    jointIndex: 1,
                    materialID: 1,
                    normalizedMaterialCoordinate: 1,
                    position: SIMD3(100, 0, 0),
                    orientation: simd_quatd(vector: -identity.vector)
                )
            ]
        )

        let rig = snapshot.fixedRigSnapshot()
        #expect(rig.joints.count == 64)
        #expect(rig.joints.allSatisfy { quaternionGeodesic($0.orientation, identity) < 1e-12 })
    }

    @Test("invalid timesteps pins and lengths are rejected or clamped deliberately")
    func invalidRuntimeInputs() {
        var rod = HoseRod(configuration: .voiceVAC, seed: 3)
        let initial = rod.snapshot

        expectFailure(rod.step(deltaTime: 0, iterations: 12))
        expectFailure(rod.step(deltaTime: -.infinity, iterations: 12))
        expectFailure(rod.step(deltaTime: step, iterations: 0))
        expectFailure(rod.step(deltaTime: 1, iterations: 12))
        expectFailure(rod.step(deltaTime: step, iterations: 10_000))
        #expect(rod.snapshot == initial)

        expectFailure(rod.pinRoot(SIMD3(.nan, 0, 0), orientation: .identity))
        expectFailure(rod.pinTip(.zero, orientation: simd_quatd(vector: SIMD4(.nan, 0, 0, 1))))
        #expect(rod.snapshot == initial)

        expectFailure(rod.setActiveLength(.nan))
        #expect(rod.snapshot == initial)
        expectSuccess(rod.setActiveLength(-42))
        #expect(rod.activeLength == 0)
        #expect(rod.activeNodeCount == 2)
    }
}

private extension HoseJointSample {
    var isFinite: Bool {
        position.x.isFinite && position.y.isFinite && position.z.isFinite &&
            orientation.vector.x.isFinite && orientation.vector.y.isFinite &&
            orientation.vector.z.isFinite && orientation.vector.w.isFinite
    }
}

private func quaternionDistance(
    _ lhs: simd_quatd?,
    _ rhs: simd_quatd
) -> Double {
    guard let lhs else { return .infinity }
    return simd_length(lhs.vector - rhs.vector)
}

private func expectSuccess(_ result: Bool) {
    #expect(result)
}

private func expectFailure(_ result: Bool) {
    #expect(!result)
}

private func expectDeploymentSuccess(
    _ result: Result<Void, HoseSimulationFailure>
) {
    guard case .success = result else {
        Issue.record("Expected deployment update to succeed, got \(result)")
        return
    }
}

private func quaternionGeodesic(_ lhs: simd_quatd, _ rhs: simd_quatd) -> Double {
    let dot = abs(simd_dot(lhs.vector, rhs.vector))
    return 2 * acos(max(-1, min(1, dot)))
}

private func testFrame(
    forward: SIMD3<Double>,
    roll: Double
) -> simd_quatd {
    let normalizedForward = simd_normalize(forward)
    let align = simd_quatd(from: SIMD3<Double>(1, 0, 0), to: normalizedForward)
    let swivel = simd_quatd(angle: roll, axis: normalizedForward)
    return simd_normalize(swivel * align)
}
