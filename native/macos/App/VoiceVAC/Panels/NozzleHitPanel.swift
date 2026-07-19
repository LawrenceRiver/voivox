import AppKit

@MainActor
final class NozzleHitPanel: NSPanel, PanelControlling {
    let role = PanelRole.nozzle

    init(frame: CGRect) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)
        contentView = NSView(frame: CGRect(origin: .zero, size: frame.size))
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
