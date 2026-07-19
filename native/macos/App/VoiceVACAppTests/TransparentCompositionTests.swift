import AppKit
import MetalKit
import RealityKit
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class TransparentCompositionTests: XCTestCase {
    func testAuthoredDeviceFitsInsideTheCapsuleCameraWithBreathingRoom() async throws {
        let capsuleSize = OverlayMetrics.phaseOne.capsuleSize
        let device = try await RealityAssetLoader().loadDevice()
        let anchor = AnchorEntity(world: .zero)
        device.position = DeviceRealityView.deviceOffset
        anchor.addChild(device)
        let bounds = device.visualBounds(
            recursive: true,
            relativeTo: anchor,
            excludeInactive: false
        )

        let aspect = Float(capsuleSize.width / capsuleSize.height)
        let horizontalHalfAngle = DeviceRealityView.horizontalFieldOfViewDegrees * .pi / 360
        let verticalHalfAngle = atan(tan(horizontalHalfAngle) / aspect)
        let nearestDepth = DeviceRealityView.cameraDistance - bounds.max.z
        XCTAssertGreaterThan(nearestDepth, 0, "The camera must remain in front of the entire authored device")
        let visibleHeight = 2 * nearestDepth * tan(verticalHalfAngle)

        XCTAssertLessThanOrEqual(
            bounds.extents.y,
            visibleHeight * 0.90,
            "The authored vacuum controls must retain at least 10% vertical glass breathing room"
        )
        let verticalLimit = visibleHeight * 0.45
        XCTAssertGreaterThanOrEqual(
            bounds.min.y,
            -verticalLimit,
            "The authored vacuum controls must not clip the lower glass edge"
        )
        XCTAssertLessThanOrEqual(
            bounds.max.y,
            verticalLimit,
            "The authored vacuum controls must not clip the upper glass edge"
        )
    }

    func testHoseViewportIsARealTransparentPremultipliedMetalSurface() throws {
        let viewport = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 640, height: 480),
            screenFrame: CGRect(x: -640, y: 0, width: 640, height: 480),
            backingScaleFactor: 2
        )
        let metalView = try XCTUnwrap(viewport.metalView)

        XCTAssertFalse(viewport.isOpaque)
        XCTAssertFalse(metalView.isOpaque)
        XCTAssertEqual(metalView.clearColor.alpha, 0)
        XCTAssertTrue(metalView.framebufferOnly)
        XCTAssertEqual(metalView.colorPixelFormat, .bgra8Unorm_srgb)
        XCTAssertEqual(metalView.depthStencilPixelFormat, .depth32Float)
        XCTAssertTrue(viewport.rendererContract.usesPremultipliedAlpha)
        XCTAssertEqual(viewport.rendererContract.sourceRGBBlendFactor, .one)
        XCTAssertEqual(viewport.rendererContract.destinationRGBBlendFactor, .oneMinusSourceAlpha)
        XCTAssertEqual(viewport.rendererContract.sourceAlphaBlendFactor, .one)
        XCTAssertEqual(viewport.rendererContract.destinationAlphaBlendFactor, .oneMinusSourceAlpha)
        XCTAssertEqual(viewport.rendererContract.jointMatrixCount, 64)
        XCTAssertEqual(viewport.rendererContract.correctiveWeightCount, 2)
        XCTAssertTrue(viewport.rendererContract.usesEnergyConservingMicrofacetLighting)
    }

    func testEveryScreenViewportConsumesTheExactSameImmutableSnapshotReference() throws {
        let first = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 400, height: 300),
            screenFrame: CGRect(x: 0, y: 0, width: 400, height: 300),
            backingScaleFactor: 1
        )
        let second = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 400, height: 300),
            screenFrame: CGRect(x: 400, y: 0, width: 400, height: 300),
            backingScaleFactor: 2
        )
        let snapshot = HoseRenderSnapshot.bindPose

        first.render(snapshot)
        second.render(snapshot)

        XCTAssertTrue(first.latestSnapshot === snapshot)
        XCTAssertTrue(second.latestSnapshot === snapshot)
        XCTAssertNotEqual(first.projector.screenFrame, second.projector.screenFrame)
    }

    func testMissingMetalAssetCreatesVisibleContractErrorAndNeverFallsBack() throws {
        let viewport = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 320, height: 200),
            screenFrame: CGRect(x: 0, y: 0, width: 320, height: 200),
            backingScaleFactor: 1,
            assetLoader: { throw HoseMetalAssetError.missingResource("VoiceVACHose.meshbin") }
        )

        XCTAssertNil(viewport.metalView)
        XCTAssertFalse(viewport.contractErrorLabel.isHidden)
        XCTAssertTrue(viewport.contractErrorLabel.stringValue.contains("VoiceVACHose.meshbin"))
        XCTAssertEqual(viewport.subviews, [viewport.contractErrorLabel])
    }

    func testInvalidViewportCreatesVisibleProjectionErrorWithoutMetalFallback() {
        let viewport = HoseRealityViewport(
            frame: .zero,
            screenFrame: .zero,
            backingScaleFactor: 0
        )

        XCTAssertNil(viewport.metalView)
        XCTAssertFalse(viewport.contractErrorLabel.isHidden)
        XCTAssertTrue(viewport.contractErrorLabel.stringValue.contains("invalidViewport"))
    }

    func testMissingRealityKitDeviceNodeIsAnExplicitAssetContractError() {
        XCTAssertThrowsError(try RealityAssetLoader.validateDevice(Entity())) { error in
            XCTAssertEqual(error as? RealityAssetError, .missingNode("VAC_DEVICE_ROOT"))
        }
    }

    func testDeviceLoadFailureIsVisibleInsteadOfDrawingAPrimitiveFallback() async {
        let view = DeviceRealityView(
            frame: CGRect(x: 0, y: 0, width: 406, height: 116),
            loader: FailingRealityAssetLoader()
        )

        for _ in 0..<10 where view.contractErrorLabel.isHidden {
            await Task.yield()
        }

        XCTAssertFalse(view.contractErrorLabel.isHidden)
        XCTAssertTrue(view.contractErrorLabel.stringValue.contains("VAC_DEVICE_ROOT"))
        XCTAssertTrue(view.realityView.scene.anchors.isEmpty)
    }

    func testRenderSourcePublishesOneSnapshotReferenceToEveryViewport() {
        let source = HoseRenderSnapshotSource()
        let first = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 100, height: 100),
            screenFrame: CGRect(x: 0, y: 0, width: 100, height: 100),
            backingScaleFactor: 1
        )
        let second = HoseRealityViewport(
            frame: CGRect(x: 0, y: 0, width: 100, height: 100),
            screenFrame: CGRect(x: 100, y: 0, width: 100, height: 100),
            backingScaleFactor: 2
        )
        source.register(first)
        source.register(second)
        let next = HoseRenderSnapshot.bindPose

        source.publish(next)

        XCTAssertTrue(source.latest === next)
        XCTAssertTrue(first.latestSnapshot === next)
        XCTAssertTrue(second.latestSnapshot === next)
    }

    func testHosePanelRemainsTransparentAndClickThroughWithMetalContent() {
        let panel = HoseOverlayPanel(
            screenID: .init(rawValue: 7),
            frame: CGRect(x: 0, y: 0, width: 800, height: 600)
        )

        XCTAssertTrue(panel.ignoresMouseEvents)
        XCTAssertFalse(panel.isOpaque)
        XCTAssertEqual(panel.backgroundColor, .clear)
        XCTAssertTrue(panel.contentView is HoseRealityViewport)
    }

    func testHosePanelRefreshesProjectionWhenScreenGeometryChanges() throws {
        let initial = CGRect(x: -800, y: 0, width: 800, height: 600)
        let moved = CGRect(x: 0, y: -600, width: 1_200, height: 600)
        let panel = HoseOverlayPanel(screenID: .init(rawValue: 9), frame: initial)
        let viewport = try XCTUnwrap(panel.contentView as? HoseRealityViewport)

        panel.setFrame(moved, display: false)

        XCTAssertEqual(viewport.projector.screenFrame, moved)
    }
}

@MainActor
private struct FailingRealityAssetLoader: RealityAssetLoading {
    func loadDevice() async throws -> Entity {
        throw RealityAssetError.missingNode("VAC_DEVICE_ROOT")
    }
}
