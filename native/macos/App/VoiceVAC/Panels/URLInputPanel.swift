import AppKit

@MainActor
final class URLInputPanel: NSPanel, PanelControlling {
    let role = PanelRole.urlInput

    init(frame: CGRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)
        becomesKeyOnlyIfNeeded = true

        let glass = NSGlassEffectView(frame: CGRect(origin: .zero, size: frame.size))
        glass.style = .clear
        glass.cornerRadius = min(frame.height / 2, 37)
        glass.tintColor = NSColor.white.withAlphaComponent(0.08)
        glass.contentView = NSView(frame: glass.bounds)
        contentView = glass
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}
