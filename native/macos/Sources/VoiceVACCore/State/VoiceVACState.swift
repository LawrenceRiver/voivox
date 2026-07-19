import CoreGraphics
import Foundation

public typealias VoiceVACAttemptID = UUID

public enum VoiceVACPhase: String, Codable, Sendable {
    case idle, dragging, targetDetected, tabAudioOnly, ready
    case transcribing, paused, completed, retracting, warningYellow
}

public enum VoiceVACErrorCode: String, Codable, Sendable {
    case tabNotArmed = "TAB_NOT_ARMED"
    case noPlayableMedia = "NO_PLAYABLE_MEDIA"
    case targetNavigated = "TARGET_NAVIGATED"
    case captureDenied = "CAPTURE_DENIED"
    case streamIDExpired = "STREAM_ID_EXPIRED"
    case streamEnded = "STREAM_ENDED"
    case tabClosed = "TAB_CLOSED"
    case nativeHostUnavailable = "NATIVE_HOST_UNAVAILABLE"
    case noAudioAfterTimeout = "NO_AUDIO_AFTER_TIMEOUT"
}

public struct VoiceVACFailure: Codable, Equatable, Sendable {
    public let code: VoiceVACErrorCode
    public let message: String

    public init(code: VoiceVACErrorCode, message: String) {
        self.code = code
        self.message = message
    }
}

public struct VideoTarget: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case htmlMedia = "html-media"
        case embeddedPlayer = "embedded-player"
        case tabAudio = "tab-audio"
    }

    public enum Tag: String, Codable, Sendable {
        case video, audio
    }

    public let id: String
    public let kind: Kind
    public let tag: Tag?
    public let frameID: Int
    public let documentID: String
    public let viewportRect: CGRect
    public let screenRect: CGRect
    public let activationPoint: CGPoint
    public let canDirectPlay: Bool

    public init(
        id: String,
        kind: Kind,
        tag: Tag? = nil,
        frameID: Int,
        documentID: String,
        viewportRect: CGRect,
        screenRect: CGRect,
        activationPoint: CGPoint,
        canDirectPlay: Bool
    ) {
        self.id = id
        self.kind = kind
        self.tag = tag
        self.frameID = frameID
        self.documentID = documentID
        self.viewportRect = viewportRect
        self.screenRect = screenRect
        self.activationPoint = activationPoint
        self.canDirectPlay = canDirectPlay
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = try container.decode(Kind.self, forKey: .kind)
        tag = try container.decodeIfPresent(Tag.self, forKey: .tag)
        frameID = try container.decode(Int.self, forKey: .frameID)
        documentID = try container.decode(String.self, forKey: .documentID)
        viewportRect = try container.decode(BrowserRectDTO.self, forKey: .viewportRect).cgRect
        screenRect = try container.decode(BrowserRectDTO.self, forKey: .screenRect).cgRect
        activationPoint = try container.decode(BrowserPointDTO.self, forKey: .activationPoint).cgPoint
        canDirectPlay = try container.decode(Bool.self, forKey: .canDirectPlay)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(kind, forKey: .kind)
        try container.encodeIfPresent(tag, forKey: .tag)
        try container.encode(frameID, forKey: .frameID)
        try container.encode(documentID, forKey: .documentID)
        try container.encode(BrowserRectDTO(viewportRect), forKey: .viewportRect)
        try container.encode(BrowserRectDTO(screenRect), forKey: .screenRect)
        try container.encode(BrowserPointDTO(activationPoint), forKey: .activationPoint)
        try container.encode(canDirectPlay, forKey: .canDirectPlay)
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, tag, viewportRect, screenRect, activationPoint, canDirectPlay
        case frameID = "frameId"
        case documentID = "documentId"
    }
}

private struct BrowserRectDTO: Codable {
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat

    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.size.width
        height = rect.size.height
    }

    var cgRect: CGRect {
        CGRect(x: x, y: y, width: width, height: height)
    }
}

private struct BrowserPointDTO: Codable {
    let x: CGFloat
    let y: CGFloat

    init(_ point: CGPoint) {
        x = point.x
        y = point.y
    }

    var cgPoint: CGPoint {
        CGPoint(x: x, y: y)
    }
}

public struct VoiceVACState: Codable, Equatable, Sendable {
    public var phase: VoiceVACPhase
    public var nozzleGlobalPoint: CGPoint?
    public var target: VideoTarget?
    public var transcriptPreview: String
    public var failure: VoiceVACFailure?
    public var attemptID: VoiceVACAttemptID?

    public init(
        phase: VoiceVACPhase = .idle,
        nozzleGlobalPoint: CGPoint? = nil,
        target: VideoTarget? = nil,
        transcriptPreview: String = "",
        failure: VoiceVACFailure? = nil,
        attemptID: VoiceVACAttemptID? = nil
    ) {
        self.phase = phase
        self.nozzleGlobalPoint = nozzleGlobalPoint
        self.target = target
        self.transcriptPreview = transcriptPreview
        self.failure = failure
        self.attemptID = attemptID
    }

    public static let idle = VoiceVACState()
}

public enum VoiceVACAction: Equatable, Sendable {
    case beginNozzleDrag(at: CGPoint, attemptID: VoiceVACAttemptID)
    case moveNozzle(to: CGPoint)
    case targetDetected(VideoTarget, attemptID: VoiceVACAttemptID)
    case targetResolved(VideoTarget, attemptID: VoiceVACAttemptID)
    case targetRejected(VoiceVACFailure, attemptID: VoiceVACAttemptID)
    case primaryButtonPressed
    case transcriptPreviewChanged(String)
    case captureCompleted
    case retractRequested
    case retractionCompleted
}

public enum VoiceVACEffect: Equatable, Sendable {
    case startCapture(VideoTarget)
    case pauseCapture
    case resumeCapture
    case stopAndFlush
    case beginRetraction
}

public struct VoiceVACTransition: Equatable, Sendable {
    public let state: VoiceVACState
    public let effects: [VoiceVACEffect]

    public init(state: VoiceVACState, effects: [VoiceVACEffect] = []) {
        self.state = state
        self.effects = effects
    }
}
