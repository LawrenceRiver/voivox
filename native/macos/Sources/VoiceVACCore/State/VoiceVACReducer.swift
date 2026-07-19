public enum VoiceVACReducer {
    public static func reduce(
        state: VoiceVACState,
        action: VoiceVACAction
    ) -> VoiceVACTransition {
        var next = state
        var effects: [VoiceVACEffect] = []

        switch action {
        case let .beginNozzleDrag(point):
            next.phase = .dragging
            next.nozzleGlobalPoint = point
            next.target = nil
            next.failure = nil

        case let .moveNozzle(point):
            next.nozzleGlobalPoint = point

        case let .targetDetected(target):
            if next.phase == .dragging {
                next.phase = target.kind == .tabAudio ? .tabAudioOnly : .targetDetected
                next.target = target
                next.failure = nil
            }

        case let .targetResolved(target):
            if next.phase == .targetDetected || next.phase == .tabAudioOnly {
                next.phase = .ready
                next.target = target
                next.failure = nil
            }

        case let .targetRejected(failure):
            next.phase = .warningYellow
            next.target = nil
            next.failure = failure

        case .primaryButtonPressed:
            switch next.phase {
            case .ready:
                if let target = next.target {
                    next.phase = .transcribing
                    effects = [.startCapture(target)]
                }
            case .transcribing:
                next.phase = .paused
                effects = [.pauseCapture]
            case .paused:
                next.phase = .transcribing
                effects = [.resumeCapture]
            case .idle, .dragging, .targetDetected, .tabAudioOnly,
                    .completed, .retracting, .warningYellow:
                break
            }

        case let .transcriptPreviewChanged(preview):
            next.transcriptPreview = preview

        case .captureCompleted:
            if next.phase == .transcribing || next.phase == .paused {
                next.phase = .completed
            }

        case .retractRequested:
            next.phase = .retracting
            effects = [.stopAndFlush, .beginRetraction]

        case .retractionCompleted:
            if next.phase == .retracting {
                next = .idle
            }
        }

        return VoiceVACTransition(state: next, effects: effects)
    }
}
