import AppKit

@MainActor
final class URLInputPanel: NSPanel, PanelControlling {
    let role = PanelRole.urlInput
    let inputView: NozzleURLInputView

    init(frame: CGRect, onSubmit: @escaping (URL) -> Void = { _ in }) {
        inputView = NozzleURLInputView(onSubmit: onSubmit)
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
        let host = NSView(frame: glass.bounds)
        host.autoresizingMask = [.width, .height]
        inputView.frame = host.bounds
        inputView.autoresizingMask = [.width, .height]
        host.addSubview(inputView)
        glass.contentView = host
        contentView = glass
        setAccessibilityIdentifier("voice-vac-url-panel")
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func orderFrontRegardless() {
        super.orderFrontRegardless()
        inputView.setPresented(true)
    }

    override func orderOut(_ sender: Any?) {
        inputView.setPresented(false)
        super.orderOut(sender)
    }
}
