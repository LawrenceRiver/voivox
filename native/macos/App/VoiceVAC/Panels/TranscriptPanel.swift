import AppKit

@MainActor
final class TranscriptPanel: NSPanel, PanelControlling {
    let role = PanelRole.transcript
    let glass: TranscriptGlassView

    init(frame: CGRect, store: VoiceVACStore = VoiceVACStore()) {
        glass = TranscriptGlassView(
            frame: CGRect(origin: .zero, size: frame.size),
            store: store
        )
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)
        becomesKeyOnlyIfNeeded = true
        contentView = glass
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
