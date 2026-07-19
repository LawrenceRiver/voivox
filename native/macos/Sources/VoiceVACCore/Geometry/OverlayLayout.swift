import CoreGraphics
import Foundation

public struct ScreenID: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: UInt32

    public init(rawValue: UInt32) {
        self.rawValue = rawValue
    }
}

public struct ScreenDescriptor: Equatable, Sendable {
    public let id: ScreenID
    public let frame: CGRect
    public let visibleFrame: CGRect
    public let backingScaleFactor: CGFloat

    public init(
        id: ScreenID,
        frame: CGRect,
        visibleFrame: CGRect,
        backingScaleFactor: CGFloat
    ) {
        self.id = id
        self.frame = frame
        self.visibleFrame = visibleFrame
        self.backingScaleFactor = backingScaleFactor
    }
}

public struct OverlayMetrics: Equatable, Sendable {
    public let capsuleSize: CGSize
    public let edgeInset: CGFloat
    public let nozzleHitSize: CGSize
    public let transcriptSize: CGSize
    public let transcriptGap: CGFloat

    public init(
        capsuleSize: CGSize,
        edgeInset: CGFloat,
        nozzleHitSize: CGSize,
        transcriptSize: CGSize,
        transcriptGap: CGFloat
    ) {
        self.capsuleSize = capsuleSize
        self.edgeInset = edgeInset
        self.nozzleHitSize = nozzleHitSize
        self.transcriptSize = transcriptSize
        self.transcriptGap = transcriptGap
    }

    public static let phaseOne = OverlayMetrics(
        capsuleSize: CGSize(width: 406, height: 116),
        edgeInset: 24,
        nozzleHitSize: CGSize(width: 96, height: 96),
        transcriptSize: CGSize(width: 318, height: 74),
        transcriptGap: 12
    )
}

public struct CapsulePlacement: Codable, Equatable, Sendable {
    public let screenID: ScreenID
    public let normalizedOrigin: CGPoint

    public init(screenID: ScreenID, normalizedOrigin: CGPoint) {
        self.screenID = screenID
        self.normalizedOrigin = normalizedOrigin
    }
}

public struct OverlayLayout: Equatable, Sendable {
    public let capsuleScreenID: ScreenID
    public let capsuleFrame: CGRect
    public let hoseFrames: [ScreenID: CGRect]
    public let nozzleHitFrame: CGRect
    public let transcriptFrame: CGRect

    public init(
        capsuleScreenID: ScreenID,
        capsuleFrame: CGRect,
        hoseFrames: [ScreenID: CGRect],
        nozzleHitFrame: CGRect,
        transcriptFrame: CGRect
    ) {
        self.capsuleScreenID = capsuleScreenID
        self.capsuleFrame = capsuleFrame
        self.hoseFrames = hoseFrames
        self.nozzleHitFrame = nozzleHitFrame
        self.transcriptFrame = transcriptFrame
    }
}
