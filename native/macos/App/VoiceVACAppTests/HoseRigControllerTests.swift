import CoreGraphics
import simd
import VoiceVACCore
import XCTest
@testable import Voice_VAC

final class HoseRigControllerTests: XCTestCase {
    @MainActor
    func testProductionRenderSessionPublishesCoreRodSnapshotToSharedSource() throws {
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 81)
        let nozzleFrame = CGRect(x: 900, y: 120, width: 96, height: 96)

        try session.dock(in: nozzleFrame)

        let snapshot = try XCTUnwrap(source.latest)
        XCTAssertEqual(snapshot.jointMatrices.count, 64)
        let tip = snapshot.jointMatrices[63].columns.3
        XCTAssertEqual(tip.x, Float(nozzleFrame.midX / 1_000), accuracy: 0.000_1)
        XCTAssertEqual(tip.y, Float(nozzleFrame.midY / 1_000), accuracy: 0.000_1)
    }

    func testMapsEveryFixedRigJointIntoOneImmutableWorldSnapshot() throws {
        var rod = HoseRod(configuration: .voiceVAC, seed: 91)
        let result = rod.configurePins(
            rootPosition: SIMD3(120, 240, 0),
            rootOrientation: .identity,
            tipPosition: SIMD3(720, 480, 30),
            tipOrientation: simd_quatd(angle: .pi / 8, axis: SIMD3(0, 0, 1)),
            activeLength: 720
        )
        guard case .success = result else { return XCTFail("fixture must be feasible") }

        let rig = rod.snapshot.fixedRigSnapshot()
        let snapshot = try HoseRigController(pointsPerMeter: 1_000).makeRenderSnapshot(from: rig)

        XCTAssertEqual(snapshot.jointMatrices.count, 64)
        XCTAssertEqual(snapshot.jointNames, (0..<64).map { String(format: "VAC_HOSE_JOINT_%02d", $0) })
        for index in 0..<64 {
            let translation = snapshot.jointMatrices[index].columns.3
            XCTAssertEqual(translation.x, Float(rig.joints[index].position.x / 1_000), accuracy: 0.000_01)
            XCTAssertEqual(translation.y, Float(rig.joints[index].position.y / 1_000), accuracy: 0.000_01)
            XCTAssertEqual(translation.z, Float(rig.joints[index].position.z / 1_000), accuracy: 0.000_01)
        }
        XCTAssertTrue(snapshot.correctiveWeights.x.isFinite)
        XCTAssertTrue(snapshot.correctiveWeights.y.isFinite)
    }

    func testScreenProjectionUsesPointsForLayoutAndPixelsOnlyForDrawableSizing() throws {
        let projector = try ScreenPointProjector(
            screenFrame: CGRect(x: -1_440, y: -120, width: 1_440, height: 900),
            backingScaleFactor: 2
        )

        XCTAssertEqual(projector.localPoint(forGlobalPoint: CGPoint(x: -720, y: 330)), CGPoint(x: 720, y: 450))
        XCTAssertEqual(projector.drawablePoint(forGlobalPoint: CGPoint(x: -720, y: 330)), CGPoint(x: 1_440, y: 900))
        XCTAssertEqual(projector.drawableSize, CGSize(width: 2_880, height: 1_800))

        let projection = projector.worldToClipMatrix(pointsPerMeter: 1_000)
        let center = projection * SIMD4<Float>(-0.720, 0.330, 0, 1)
        XCTAssertEqual(center.x / center.w, 0, accuracy: 0.000_01)
        XCTAssertEqual(center.y / center.w, 0, accuracy: 0.000_01)
    }

    func testProjectionRejectsInvalidViewportInsteadOfProducingNaNs() {
        XCTAssertThrowsError(
            try ScreenPointProjector(screenFrame: .zero, backingScaleFactor: 2)
        ) { error in
            XCTAssertEqual(error as? ScreenPointProjectionError, .invalidViewport)
        }
        XCTAssertThrowsError(
            try ScreenPointProjector(screenFrame: CGRect(x: 0, y: 0, width: 10, height: 10), backingScaleFactor: 0)
        ) { error in
            XCTAssertEqual(error as? ScreenPointProjectionError, .invalidScaleFactor)
        }
    }
}
