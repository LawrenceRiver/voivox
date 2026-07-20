import AppKit
import MetalKit
import RealityKit
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class TransparentCompositionTests: XCTestCase {
    func testActiveAuthoredDeviceProducesAReadableCenteredCapsuleFraming() async throws {
        let capsuleSize = OverlayMetrics.phaseOne.capsuleSize
        let controller = VoiceVACDeviceInteractionController()
        let device = try await controller.loadMainDevice()
        let bounds = DeviceRealityView.activeVisualBounds(entity: device)
        let framing = try DeviceRealityView.framing(entity: device, viewport: capsuleSize)
        let projected = framing.project(bounds: bounds)

        XCTAssertGreaterThanOrEqual(projected.width, 280)
        XCTAssertGreaterThanOrEqual(projected.height, 90)
        XCTAssertGreaterThanOrEqual(projected.minX, 8)
        XCTAssertLessThanOrEqual(projected.maxX, capsuleSize.width - 8)
        XCTAssertGreaterThanOrEqual(projected.minY, 8)
        XCTAssertLessThanOrEqual(projected.maxY, capsuleSize.height - 8)
        XCTAssertEqual(projected.midX, capsuleSize.width / 2, accuracy: 0.5)
        XCTAssertEqual(projected.midY, capsuleSize.height / 2, accuracy: 0.5)
        XCTAssertNotNil(device.findEntity(named: "VAC_PORT"))
        XCTAssertNotNil(device.findEntity(named: "VAC_BUTTON_CAP"))
    }

    func testAuthoredNozzleProducesAReadableFramingInsideIts96PointHitPanel() async throws {
        let controller = VoiceVACDeviceInteractionController()
        let nozzle = try await controller.loadNozzleClone()
        let root = Entity()
        root.addChild(nozzle)
        controller.bindNozzlePresentationRoot(root)
        let bounds = DeviceRealityView.activeVisualBounds(entity: root)
        let size = NozzleHitPanel.dockedSize
        let framing = try DeviceRealityView.framing(entity: root, viewport: size)
        let projected = framing.project(bounds: bounds)

        XCTAssertEqual(bounds.center.x, 0, accuracy: 0.001)
        XCTAssertEqual(framing.lookAtPosition.x, bounds.center.x, accuracy: 0.001)
        XCTAssertEqual(framing.lookAtPosition.y, bounds.center.y, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(projected.height, 76)
        XCTAssertLessThanOrEqual(projected.height, 82)
        XCTAssertGreaterThanOrEqual(projected.minY, 7)
        XCTAssertLessThanOrEqual(projected.maxY, size.height - 7)
        XCTAssertEqual(projected.midX, size.width / 2, accuracy: 0.5)
        XCTAssertEqual(projected.midY, size.height / 2, accuracy: 0.5)
        XCTAssertNotNil(root.findEntity(named: "VAC_NOZZLE_TIP"))
    }

    func testRuntimeUSDZControlBoundsMatchTheSharedDesignProjection() async throws {
        let controller = VoiceVACDeviceInteractionController()
        let device = try await controller.loadMainDevice()
        let port = try XCTUnwrap(device.findEntity(named: "VAC_PORT"))
        let button = try XCTUnwrap(device.findEntity(named: "VAC_BUTTON_CAP"))
        let framing = try DeviceRealityView.framing(
            entity: device,
            viewport: OverlayMetrics.phaseOne.capsuleSize
        )
        let runtimePort = try framing.projectVisualBounds(
            DeviceRealityView.activeVisualBounds(entity: port)
        )
        let runtimeButton = try framing.projectVisualBounds(
            DeviceRealityView.activeVisualBounds(entity: button)
        )
        let design = CapsuleControlLayout.projection

        XCTAssertEqual(runtimePort.midX, design.portAnchor.x, accuracy: 1)
        XCTAssertEqual(runtimePort.midY, design.portAnchor.y, accuracy: 1)
        XCTAssertEqual(runtimeButton.midX, design.buttonAnchor.x, accuracy: 1)
        XCTAssertEqual(runtimeButton.midY, design.buttonAnchor.y, accuracy: 1)
        XCTAssertTrue(design.portHitFrame.contains(runtimePort))
        XCTAssertTrue(design.buttonHitFrame.contains(runtimeButton))
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
