import CoreGraphics
import simd

enum ScreenPointProjectionError: Error, Equatable {
    case invalidViewport
    case invalidScaleFactor
    case invalidPointsPerMeter
}

struct ScreenPointProjector: Equatable, Sendable {
    static let unit = ScreenPointProjector(
        validatedScreenFrame: CGRect(x: 0, y: 0, width: 1, height: 1),
        backingScaleFactor: 1
    )

    let screenFrame: CGRect
    let backingScaleFactor: CGFloat

    init(screenFrame: CGRect, backingScaleFactor: CGFloat) throws {
        guard screenFrame.origin.x.isFinite, screenFrame.origin.y.isFinite,
              screenFrame.width.isFinite, screenFrame.height.isFinite,
              screenFrame.width > 0, screenFrame.height > 0
        else { throw ScreenPointProjectionError.invalidViewport }
        guard backingScaleFactor.isFinite, backingScaleFactor > 0 else {
            throw ScreenPointProjectionError.invalidScaleFactor
        }
        self.screenFrame = screenFrame
        self.backingScaleFactor = backingScaleFactor
    }

    private init(validatedScreenFrame: CGRect, backingScaleFactor: CGFloat) {
        screenFrame = validatedScreenFrame
        self.backingScaleFactor = backingScaleFactor
    }

    var drawableSize: CGSize {
        CGSize(
            width: screenFrame.width * backingScaleFactor,
            height: screenFrame.height * backingScaleFactor
        )
    }

    func localPoint(forGlobalPoint point: CGPoint) -> CGPoint {
        CGPoint(x: point.x - screenFrame.minX, y: point.y - screenFrame.minY)
    }

    func drawablePoint(forGlobalPoint point: CGPoint) -> CGPoint {
        let local = localPoint(forGlobalPoint: point)
        return CGPoint(x: local.x * backingScaleFactor, y: local.y * backingScaleFactor)
    }

    /// Projects shared global desktop-space metres to this display's clip space.
    /// AppKit layout remains in points; Retina scaling is deliberately absent here.
    func worldToClipMatrix(pointsPerMeter: Float) -> simd_float4x4 {
        precondition(pointsPerMeter.isFinite && pointsPerMeter > 0)
        let left = Float(screenFrame.minX) / pointsPerMeter
        let right = Float(screenFrame.maxX) / pointsPerMeter
        let bottom = Float(screenFrame.minY) / pointsPerMeter
        let top = Float(screenFrame.maxY) / pointsPerMeter
        return simd_float4x4(columns: (
            SIMD4(2 / (right - left), 0, 0, 0),
            SIMD4(0, 2 / (top - bottom), 0, 0),
            SIMD4(0, 0, -1, 0),
            SIMD4(
                -(right + left) / (right - left),
                -(top + bottom) / (top - bottom),
                0,
                1
            )
        ))
    }
}
