import CoreGraphics
import Foundation

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

    private enum CodingKeys: String, CodingKey {
        case id, kind, tag, viewportRect, screenRect, activationPoint, canDirectPlay
        case frameID = "frameId"
        case documentID = "documentId"
    }
}

public struct VoiceVACState: Codable, Equatable, Sendable {
    public var phase: VoiceVACPhase
    public var nozzleGlobalPoint: CGPoint?
    public var target: VideoTarget?
    public var transcriptPreview: String
    public var failure: VoiceVACFailure?

    public init(
        phase: VoiceVACPhase = .idle,
        nozzleGlobalPoint: CGPoint? = nil,
        target: VideoTarget? = nil,
        transcriptPreview: String = "",
        failure: VoiceVACFailure? = nil
    ) {
        self.phase = phase
        self.nozzleGlobalPoint = nozzleGlobalPoint
        self.target = target
        self.transcriptPreview = transcriptPreview
        self.failure = failure
    }

    public static let idle = VoiceVACState()
}

public enum VoiceVACAction: Equatable, Sendable {
    case beginNozzleDrag(at: CGPoint)
    case moveNozzle(to: CGPoint)
    case targetResolved(VideoTarget)
    case targetRejected(VoiceVACFailure)
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
