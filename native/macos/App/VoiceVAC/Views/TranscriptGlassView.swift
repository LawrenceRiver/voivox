import AppKit
import Observation
import VoiceVACCore

@MainActor
final class TranscriptGlassView: NSGlassEffectView {
    let titleLabel = NSTextField(labelWithString: "Voice VAC")
    let statusLabel = NSTextField(labelWithString: "Waiting")
    let previewLabel = NSTextField(labelWithString: "")
    let copyButton = NSButton(title: "Copy", target: nil, action: nil)
    let store: VoiceVACStore

    init(frame frameRect: NSRect, store: VoiceVACStore = VoiceVACStore()) {
        self.store = store
        super.init(frame: frameRect)

        style = .clear
        cornerRadius = 37
        tintColor = NSColor.white.withAlphaComponent(0.08)
        autoresizingMask = [.width, .height]

        let contentHost = NSView(frame: CGRect(origin: .zero, size: frameRect.size))
        contentHost.autoresizingMask = [.width, .height]

        titleLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.frame = CGRect(x: 16, y: 43, width: 68, height: 18)
        titleLabel.setAccessibilityIdentifier("voice-vac-transcript-title")
        contentHost.addSubview(titleLabel)

        statusLabel.font = .systemFont(ofSize: 10, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.frame = CGRect(x: 86, y: 43, width: 148, height: 18)
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.setAccessibilityIdentifier("voice-vac-transcript-status")
        contentHost.addSubview(statusLabel)

        previewLabel.font = .systemFont(ofSize: 12, weight: .regular)
        previewLabel.textColor = .labelColor
        previewLabel.frame = CGRect(x: 16, y: 13, width: 226, height: 25)
        previewLabel.lineBreakMode = .byTruncatingTail
        previewLabel.maximumNumberOfLines = 1
        previewLabel.setAccessibilityIdentifier("voice-vac-transcript-preview")
        contentHost.addSubview(previewLabel)

        copyButton.bezelStyle = .texturedRounded
        copyButton.font = .systemFont(ofSize: 11, weight: .semibold)
        copyButton.frame = CGRect(x: 248, y: 20, width: 58, height: 32)
        copyButton.autoresizingMask = [.minXMargin]
        copyButton.target = self
        copyButton.action = #selector(copyTranscript)
        copyButton.setAccessibilityIdentifier("voice-vac-copy-transcript")
        copyButton.setAccessibilityLabel("Copy transcript")
        contentHost.addSubview(copyButton)

        contentView = contentHost
        synchronize()
        observeStoreState()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    @objc private func copyTranscript() {
        let transcript = store.state.transcriptPreview
        guard !transcript.isEmpty else { return }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(transcript, forType: .string)
        copyButton.title = "Copied"
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1.1))
            self?.copyButton.title = "Copy"
        }
    }

    private func synchronize() {
        previewLabel.stringValue = store.state.transcriptPreview
        statusLabel.stringValue = statusText(for: store.state)
        statusLabel.textColor = store.state.phase == .warningYellow ? .systemYellow : .secondaryLabelColor
        copyButton.isEnabled = !store.state.transcriptPreview.isEmpty
    }

    private func statusText(for state: VoiceVACState) -> String {
        if let failure = state.failure { return failure.message }
        switch state.phase {
        case .idle: return "Waiting"
        case .dragging, .targetDetected, .tabAudioOnly: return "Connecting…"
        case .ready: return "Ready"
        case .transcribing: return "Transcribing…"
        case .paused: return "Paused"
        case .completed: return "Completed"
        case .retracting: return "Retracting…"
        case .warningYellow: return "No playable video found"
        }
    }

    private func observeStoreState() {
        withObservationTracking {
            _ = store.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                synchronize()
                observeStoreState()
            }
        }
    }
}
