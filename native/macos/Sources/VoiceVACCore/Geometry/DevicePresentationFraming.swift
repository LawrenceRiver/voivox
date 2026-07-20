import CoreGraphics

public enum DevicePresentationFramingError: Error, Equatable, Sendable {
    case invalidViewport
    case invalidFieldOfView
    case invalidFillFraction
    case emptyBounds
    case pointBehindCamera
}

public struct DeviceVisualBounds: Equatable, Sendable {
    public let minimum: SIMD3<Float>
    public let maximum: SIMD3<Float>

    public init(minimum: SIMD3<Float>, maximum: SIMD3<Float>) {
        self.minimum = minimum
        self.maximum = maximum
    }

    public var center: SIMD3<Float> { (minimum + maximum) / 2 }
    public var extents: SIMD3<Float> { maximum - minimum }
}

/// A deterministic perspective-camera contract for the real authored USDZ controls.
///
/// RealityKit's default camera is intentionally not used: its distance is unrelated to
/// the tiny overlay viewport and previously reduced the device to a dark sliver. The
/// camera is centered on the active visual bounds, then placed far enough in front of
/// the nearest corner that both axes retain the requested clear-glass breathing room.
public struct DevicePresentationFraming: Equatable, Sendable {
    public let viewport: CGSize
    public let horizontalFieldOfViewDegrees: Float
    public let fillFraction: Float
    public let cameraPosition: SIMD3<Float>
    public let lookAtPosition: SIMD3<Float>

    public static func fit(
        bounds: DeviceVisualBounds,
        viewport: CGSize,
        horizontalFieldOfViewDegrees: Float,
        fillFraction: Float
    ) throws -> Self {
        guard viewport.width.isFinite,
              viewport.height.isFinite,
              viewport.width > 0,
              viewport.height > 0
        else { throw DevicePresentationFramingError.invalidViewport }
        guard horizontalFieldOfViewDegrees.isFinite,
              horizontalFieldOfViewDegrees > 1,
              horizontalFieldOfViewDegrees < 179
        else { throw DevicePresentationFramingError.invalidFieldOfView }
        guard fillFraction.isFinite, fillFraction > 0, fillFraction < 1 else {
            throw DevicePresentationFramingError.invalidFillFraction
        }

        let extents = bounds.extents
        guard extents.x.isFinite,
              extents.y.isFinite,
              extents.z.isFinite,
              extents.x > 0,
              extents.y > 0,
              extents.z >= 0
        else { throw DevicePresentationFramingError.emptyBounds }

        let horizontalHalfAngle = horizontalFieldOfViewDegrees * .pi / 360
        let aspect = Float(viewport.width / viewport.height)
        let verticalHalfAngle = atan(tan(horizontalHalfAngle) / aspect)
        let horizontalClearance = extents.x / (2 * tan(horizontalHalfAngle) * fillFraction)
        let verticalClearance = extents.y / (2 * tan(verticalHalfAngle) * fillFraction)
        let clearanceFromNearestCorner = max(horizontalClearance, verticalClearance)
        let center = bounds.center

        return Self(
            viewport: viewport,
            horizontalFieldOfViewDegrees: horizontalFieldOfViewDegrees,
            fillFraction: fillFraction,
            cameraPosition: SIMD3(center.x, center.y, bounds.maximum.z + clearanceFromNearestCorner),
            lookAtPosition: center
        )
    }

    /// Conservative screen-space bounds, using the nearest visual depth for every edge.
    public func project(bounds: DeviceVisualBounds) -> CGRect {
        let nearestDepth = cameraPosition.z - bounds.maximum.z
        let horizontalHalfAngle = horizontalFieldOfViewDegrees * .pi / 360
        let focalLength = Float(viewport.width) / (2 * tan(horizontalHalfAngle))
        let width = CGFloat(focalLength * bounds.extents.x / nearestDepth)
        let height = CGFloat(focalLength * bounds.extents.y / nearestDepth)
        return CGRect(
            x: (viewport.width - width) / 2,
            y: (viewport.height - height) / 2,
            width: width,
            height: height
        )
    }

    /// Projects one authored 3D point into the AppKit viewport used by RealityKit.
    /// The presentation camera always faces straight down -Z, so this is the exact
    /// perspective mapping used for control anchors layered above the real mesh.
    public func project(point: SIMD3<Float>) throws -> CGPoint {
        let depth = cameraPosition.z - point.z
        guard depth.isFinite, depth > 0 else {
            throw DevicePresentationFramingError.pointBehindCamera
        }
        let horizontalHalfAngle = horizontalFieldOfViewDegrees * .pi / 360
        let focalLength = Float(viewport.width) / (2 * tan(horizontalHalfAngle))
        return CGPoint(
            x: viewport.width / 2
                + CGFloat(focalLength * (point.x - lookAtPosition.x) / depth),
            y: viewport.height / 2
                + CGFloat(focalLength * (point.y - lookAtPosition.y) / depth)
        )
    }

    /// Projects all eight corners instead of assuming the bounds are centered.
    /// This is used to prove that a fixed-size interaction target fully covers the
    /// visible `VAC_PORT` or `VAC_BUTTON_CAP` mesh after perspective projection.
    public func projectVisualBounds(_ bounds: DeviceVisualBounds) throws -> CGRect {
        var minimum = CGPoint(x: CGFloat.infinity, y: CGFloat.infinity)
        var maximum = CGPoint(x: -CGFloat.infinity, y: -CGFloat.infinity)

        for x in [bounds.minimum.x, bounds.maximum.x] {
            for y in [bounds.minimum.y, bounds.maximum.y] {
                for z in [bounds.minimum.z, bounds.maximum.z] {
                    let point = try project(point: SIMD3(x, y, z))
                    minimum.x = min(minimum.x, point.x)
                    minimum.y = min(minimum.y, point.y)
                    maximum.x = max(maximum.x, point.x)
                    maximum.y = max(maximum.y, point.y)
                }
            }
        }
        return CGRect(
            x: minimum.x,
            y: minimum.y,
            width: maximum.x - minimum.x,
            height: maximum.y - minimum.y
        )
    }
}

public struct DeviceControlProjection: Equatable, Sendable {
    public let viewport: CGSize
    public let portAnchor: CGPoint
    public let buttonAnchor: CGPoint
    public let portMeshFrame: CGRect
    public let buttonMeshFrame: CGRect
    public let portHitFrame: CGRect
    public let buttonHitFrame: CGRect
}

/// Stable measured geometry from `VoiceVACDevice.usdz`.
///
/// Both the RealityKit camera and the AppKit interaction overlays consume this design
/// projection. Updating the authored model therefore has one deliberately testable
/// place where its bounds must be refreshed; stale edge-aligned hit rectangles cannot
/// silently survive a camera or scale change.
public enum VoiceVACDevicePresentationDesign {
    public static let horizontalFieldOfViewDegrees: Float = 40
    public static let fillFraction: Float = 0.82

    public static let activeDeviceBounds = DeviceVisualBounds(
        minimum: SIMD3(-0.192_171_08, -0.059_331_045, -0.035),
        maximum: SIMD3(0.189_331_05, 0.063_331_045, 0.058_999_99)
    )
    public static let portBounds = DeviceVisualBounds(
        minimum: SIMD3(-0.192_171_08, -0.058_171_086, -0.035),
        maximum: SIMD3(-0.071_828_92, 0.062_171_087, 0.023_000_002)
    )
    public static let buttonCapBounds = DeviceVisualBounds(
        minimum: SIMD3(0.080_933_94, -0.044_674_244, 0.017_999_997),
        maximum: SIMD3(0.175_066_07, 0.048_674_24, 0.058_999_99)
    )

    public static func makeControlProjection(
        viewport: CGSize,
        hitTargetSize: CGSize
    ) throws -> DeviceControlProjection {
        guard hitTargetSize.width.isFinite,
              hitTargetSize.height.isFinite,
              hitTargetSize.width > 0,
              hitTargetSize.height > 0
        else { throw DevicePresentationFramingError.invalidViewport }

        let framing = try DevicePresentationFraming.fit(
            bounds: activeDeviceBounds,
            viewport: viewport,
            horizontalFieldOfViewDegrees: horizontalFieldOfViewDegrees,
            fillFraction: fillFraction
        )
        let portMeshFrame = try framing.projectVisualBounds(portBounds)
        let buttonMeshFrame = try framing.projectVisualBounds(buttonCapBounds)
        let portAnchor = CGPoint(x: portMeshFrame.midX, y: portMeshFrame.midY)
        let buttonAnchor = CGPoint(x: buttonMeshFrame.midX, y: buttonMeshFrame.midY)

        return DeviceControlProjection(
            viewport: viewport,
            portAnchor: portAnchor,
            buttonAnchor: buttonAnchor,
            portMeshFrame: portMeshFrame,
            buttonMeshFrame: buttonMeshFrame,
            portHitFrame: hitFrame(centeredAt: portAnchor, size: hitTargetSize),
            buttonHitFrame: hitFrame(centeredAt: buttonAnchor, size: hitTargetSize)
        )
    }

    private static func hitFrame(centeredAt center: CGPoint, size: CGSize) -> CGRect {
        CGRect(
            x: center.x - size.width / 2,
            y: center.y - size.height / 2,
            width: size.width,
            height: size.height
        )
    }
}
