import CoreGraphics
import simd
import VoiceVACCore
import XCTest
@testable import Voice_VAC

final class HoseRigControllerTests: XCTestCase {
    @MainActor
    func testDockPublishesAVisibleStowedHoseInsteadOfOneSegment() throws {
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 81)

        try session.dock(in: CGRect(x: 300, y: 120, width: 96, height: 96))

        XCTAssertGreaterThan(
            session.rod.activeLength,
            session.rod.configuration.naturalSegmentLength * 2.5
        )
        XCTAssertNotNil(source.latest)
    }

    @MainActor
    func testDockKeepsTheExternalHoseInsideTheCapsuleUntilTheUserPullsTheMouth() throws {
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 87)
        let dock = CGRect(x: 300, y: 120, width: 96, height: 96)

        try session.dock(in: dock)
        XCTAssertFalse(try XCTUnwrap(source.latest).showsExternalHose)

        try session.deployVisual(toward: CGPoint(x: 1_080, y: 520))
        XCTAssertTrue(try XCTUnwrap(source.latest).showsExternalHose)
    }

    /// The inactive reservoir is a simulation convenience, not something the
    /// user should see as a dense black-and-white knot. The renderer must be
    /// told precisely where the real, visible corrugations begin.
    @MainActor
    func testDockPublishesOnlyTheActiveCorrugatedMaterialRange() throws {
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 85)

        try session.dock(in: CGRect(x: 300, y: 120, width: 96, height: 96))

        let snapshot = try XCTUnwrap(source.latest)
        XCTAssertGreaterThan(snapshot.activeMaterialStart, 0.80)
        XCTAssertLessThan(snapshot.activeMaterialStart, 0.96)
    }

    @MainActor
    func testDockKeepsTheHoseCompactWhileGivingItEnoughMaterialToCurl() throws {
        let session = HoseRenderSession(source: HoseRenderSnapshotSource(), seed: 86)
        let port = CGRect(x: 300, y: 120, width: 96, height: 96)

        try session.dock(in: port)

        let root = try XCTUnwrap(session.rootGlobalPoint)
        let tip = CGPoint(x: port.midX, y: port.midY)
        XCTAssertLessThan(hypot(tip.x - root.x, tip.y - root.y), 240)
        XCTAssertGreaterThan(session.rod.activeLength, session.rod.configuration.naturalSegmentLength * 7.5)
    }

    func testDynamicBellowsUsesActualPathLengthInsteadOfCollapsingSkinBones() {
        let geometry = HoseBellowsGeometry.make(
            centerline: [
                SIMD3<Float>(0, 0, 0),
                SIMD3<Float>(0.42, 0.08, 0),
                SIMD3<Float>(0.92, -0.10, 0),
            ]
        )

        XCTAssertGreaterThanOrEqual(geometry.ribCount, 20)
        XCTAssertGreaterThan(geometry.positions.count, 500)
        XCTAssertEqual(geometry.normals.count, geometry.positions.count)
        XCTAssertEqual(geometry.textureCoordinates.count, geometry.positions.count)
        XCTAssertEqual(geometry.indices.count % 3, 0)
        XCTAssertGreaterThan(geometry.maximumRadius, 0.020)
    }

    func testDynamicBellowsRoundsAnLShapedPhysicalPathInsteadOfMakingAVisibleKink() {
        let geometry = HoseBellowsGeometry.make(
            centerline: [
                SIMD3<Float>(0, 0, 0),
                SIMD3<Float>(0.50, 0, 0),
                SIMD3<Float>(0.50, 0.50, 0),
            ]
        )

        let smallestTurnContinuity = zip(geometry.spineTangents, geometry.spineTangents.dropFirst())
            .map { simd_dot($0, $1) }
            .min() ?? 1

        // A rendered desktop hose must bend through a soft arc. A piecewise
        // linear path has a zero dot product where its 90° joint switches.
        XCTAssertGreaterThan(smallestTurnContinuity, 0.90)
    }

    func testDynamicBellowsUsesFineAccordionSpacingRatherThanLargeBeads() {
        let geometry = HoseBellowsGeometry.make(
            centerline: [
                SIMD3<Float>(0, 0, 0),
                SIMD3<Float>(0.96, 0, 0),
            ]
        )

        // A 960-point length should read as a mouth-organ hose: many fine
        // folds, not twenty coarse spheres the width of the tube itself.
        XCTAssertGreaterThanOrEqual(geometry.ribCount, 70)
    }

    @MainActor
    func testDockPlacesTheStowedCorrugationsOutsideTheGlassPort() throws {
        let session = HoseRenderSession(source: HoseRenderSnapshotSource(), seed: 84)
        let portFrame = CGRect(x: 0, y: 0, width: 96, height: 96)

        try session.dock(in: portFrame)

        let root = try XCTUnwrap(session.rootGlobalPoint)
        XCTAssertLessThan(root.x, portFrame.minX)
        XCTAssertLessThan(root.y, portFrame.minY)
    }

    @MainActor
    func testVisualDeploymentUsesSlackInsteadOfATautLine() throws {
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 82)
        try session.dock(in: CGRect(x: 0, y: 0, width: 96, height: 96))

        try session.deployVisual(toward: CGPoint(x: -500, y: 180))

        let root = try XCTUnwrap(session.rootGlobalPoint)
        let span = hypot(-500 - root.x, 180 - root.y)
        XCTAssertGreaterThanOrEqual(session.rod.activeLength, span * 1.18)

        let centerline = try XCTUnwrap(source.latest).centerline
        let start = try XCTUnwrap(centerline.first)
        let end = try XCTUnwrap(centerline.last)
        let chord = end - start
        let chordLength = simd_length(chord)
        let greatestSag = centerline.map { point -> Float in
            abs(chord.x * (point.y - start.y) - chord.y * (point.x - start.x))
                / max(chordLength, 0.000_01)
        }.max() ?? 0

        // Slack must produce a readable C/S sweep, not merely a 1.18× rest
        // length hidden inside a visually taut line.
        XCTAssertGreaterThan(greatestSag, 0.10, "rendered sag was \(greatestSag)m")
    }

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
