import AppKit

@MainActor
final class TranscriptPanel: NSPanel, PanelControlling {
    let role = PanelRole.transcript

    init(frame: CGRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)
        becomesKeyOnlyIfNeeded = true
        contentView = TranscriptGlassView(frame: CGRect(origin: .zero, size: frame.size))
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
