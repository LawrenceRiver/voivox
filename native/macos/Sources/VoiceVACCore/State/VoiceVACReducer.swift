public enum VoiceVACReducer {
    public static func reduce(
        state: VoiceVACState,
        action: VoiceVACAction
    ) -> VoiceVACTransition {
        var next = state
        var effects: [VoiceVACEffect] = []

        switch action {
        case let .beginNozzleDrag(point, attemptID):
            next.phase = .dragging
            next.nozzleGlobalPoint = point
            next.target = nil
            next.failure = nil
            next.attemptID = attemptID

        case let .moveNozzle(point):
            next.nozzleGlobalPoint = point

        case let .targetDetected(target, attemptID):
            if next.phase == .dragging, next.attemptID == attemptID {
                next.phase = target.kind == .tabAudio ? .tabAudioOnly : .targetDetected
                next.target = target
                next.failure = nil
            }

        case let .targetResolved(target, attemptID):
            if (next.phase == .targetDetected || next.phase == .tabAudioOnly),
                next.attemptID == attemptID,
                let pendingTarget = next.target,
                pendingTarget.id == target.id,
                pendingTarget.documentID == target.documentID,
                pendingTarget.frameID == target.frameID
            {
                next.phase = .ready
                next.target = target
                next.failure = nil
            }

        case let .targetRejected(failure, attemptID):
            if next.attemptID == attemptID {
                switch next.phase {
                case .dragging, .targetDetected, .tabAudioOnly:
                    next.phase = .warningYellow
                    next.target = nil
                    next.failure = failure
                case .ready, .transcribing, .paused:
                    if next.target != nil {
                        next.phase = .warningYellow
                        next.failure = failure
                    }
                case .idle, .completed, .retracting, .warningYellow:
                    break
                }
            }

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
