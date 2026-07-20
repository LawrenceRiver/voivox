import AppKit

@MainActor
final class CapsulePanel: NSPanel, PanelControlling {
    let role = PanelRole.capsule
    let glass: CapsuleGlassView

    init(
        frame: CGRect,
        dragHandlers: CapsuleDragHandlers? = nil,
        store: VoiceVACStore = VoiceVACStore(),
        deviceController: VoiceVACDeviceInteractionController = VoiceVACDeviceInteractionController(),
        interactionRuntime: VoiceVACInteractionRuntime? = nil
    ) {
        glass = CapsuleGlassView(
            frame: CGRect(origin: .zero, size: frame.size),
            store: store,
            deviceController: deviceController,
            interactionRuntime: interactionRuntime
        )
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)

        glass.dragSurface.handlers = dragHandlers
        contentView = glass
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}
