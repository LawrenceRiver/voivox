import AppKit
import VoiceVACCore

@MainActor
final class HoseOverlayPanel: NSPanel, PanelControlling {
    let role: PanelRole

    init(screenID: ScreenID, frame: CGRect) {
        role = .hose(screenID)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role, hasShadow: false)
        ignoresMouseEvents = true
        contentView = NSView(frame: CGRect(origin: .zero, size: frame.size))
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
