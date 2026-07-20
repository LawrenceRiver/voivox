import CoreGraphics
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC 3D capsule framing")
struct DevicePresentationFramingTests {
    @Test("the authored controls fill the capsule without crossing its glass edge")
    func authoredControlsFillCapsule() throws {
        let bounds = DeviceVisualBounds(
            minimum: SIMD3(-0.192_171, -0.061_332, -0.035),
            maximum: SIMD3(0.189_331, 0.063_331, 0.059)
        )

        let framing = try DevicePresentationFraming.fit(
            bounds: bounds,
            viewport: CGSize(width: 406, height: 116),
            horizontalFieldOfViewDegrees: 40,
            fillFraction: 0.82
        )
        let projected = framing.project(bounds: bounds)

        #expect(projected.width >= 280)
        #expect(projected.height >= 90)
        #expect(projected.minX >= 8)
        #expect(projected.maxX <= 398)
        #expect(projected.minY >= 8)
        #expect(projected.maxY <= 108)
        #expect(abs(projected.midX - 203) < 0.5)
        #expect(abs(projected.midY - 58) < 0.5)
    }

    @Test("the real docked nozzle fills its 96 point transparent hit panel")
    func authoredNozzleFillsHitPanel() throws {
        let bounds = DeviceVisualBounds(
            minimum: SIMD3(-0.167_84, -0.085, 0.027),
            maximum: SIMD3(-0.096_16, 0.089, 0.140_6)
        )

        let framing = try DevicePresentationFraming.fit(
            bounds: bounds,
            viewport: CGSize(width: 96, height: 96),
            horizontalFieldOfViewDegrees: 40,
            fillFraction: 0.82
        )
        let projected = framing.project(bounds: bounds)

        #expect(projected.height >= 76)
        #expect(projected.height <= 82)
        #expect(projected.minY >= 7)
        #expect(projected.maxY <= 89)
        #expect(abs(projected.midX - 48) < 0.5)
        #expect(abs(projected.midY - 48) < 0.5)
    }

    @Test("authored port and button meshes own their complete 96 point hit targets")
    func authoredControlHitTargetsFollowPerspectiveProjection() throws {
        let projection = try VoiceVACDevicePresentationDesign.makeControlProjection(
            viewport: CGSize(width: 406, height: 116),
            hitTargetSize: CGSize(width: 96, height: 96)
        )

        #expect(abs(projection.portAnchor.x - 110) < 2)
        #expect(abs(projection.buttonAnchor.x - 301) < 2)
        #expect(abs(projection.portAnchor.y - 58) < 1)
        #expect(abs(projection.buttonAnchor.y - 58) < 1)
        #expect(projection.portHitFrame.size == CGSize(width: 96, height: 96))
        #expect(projection.buttonHitFrame.size == CGSize(width: 96, height: 96))
        #expect(projection.portHitFrame.contains(projection.portMeshFrame))
        #expect(projection.buttonHitFrame.contains(projection.buttonMeshFrame))
        #expect(CGRect(origin: .zero, size: projection.viewport).contains(projection.portHitFrame))
        #expect(CGRect(origin: .zero, size: projection.viewport).contains(projection.buttonHitFrame))
    }

    @Test("invalid camera inputs fail instead of silently rendering a sliver")
    func invalidInputsFail() {
        #expect(throws: DevicePresentationFramingError.invalidViewport) {
            try DevicePresentationFraming.fit(
                bounds: DeviceVisualBounds(minimum: .zero, maximum: SIMD3(repeating: 1)),
                viewport: .zero,
                horizontalFieldOfViewDegrees: 40,
                fillFraction: 0.82
            )
        }
        #expect(throws: DevicePresentationFramingError.emptyBounds) {
            try DevicePresentationFraming.fit(
                bounds: DeviceVisualBounds(minimum: .zero, maximum: .zero),
                viewport: CGSize(width: 406, height: 116),
                horizontalFieldOfViewDegrees: 40,
                fillFraction: 0.82
            )
        }
    }
}
