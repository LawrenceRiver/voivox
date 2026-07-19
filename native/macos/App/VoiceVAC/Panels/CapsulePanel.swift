import AppKit

@MainActor
final class CapsulePanel: NSPanel, PanelControlling {
    let role = PanelRole.capsule

    init(frame: CGRect, dragHandlers: CapsuleDragHandlers? = nil) {
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)

        let glass = CapsuleGlassView(frame: CGRect(origin: .zero, size: frame.size))
        glass.dragSurface.handlers = dragHandlers
        contentView = glass
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
