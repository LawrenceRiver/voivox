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
                expectSuccess(rod.step(deltaTime: step, iterations: 24))
            }
            let allJointsAreFinite = rod.snapshot.joints.allSatisfy { $0.isFinite }
            #expect(allJointsAreFinite)
            #expect(rod.maximumDistanceFromRoot < 4_000)
            #expect(rod.maximumSegmentStrain < 0.50)
        }
    }

    @Test("retraction removes reservoir-side nodes monotonically without teleporting material")
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
            let beforeByMaterial = Dictionary(
                uniqueKeysWithValues: rod.snapshot.joints.map { ($0.materialID, $0.position) }
            )
            rod.retract(by: amount)
            let after = rod.snapshot

            #expect(rod.activeLength <= previousLength)
            #expect(rod.activeLength >= 0)
            #expect(rod.activeNodeCount <= previousCount)
            for joint in after.joints.dropFirst() {
                if let previous = beforeByMaterial[joint.materialID] {
                    #expect(joint.position == previous)
                }
            }
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
