import AppKit

@MainActor
final class TranscriptGlassView: NSGlassEffectView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)

        style = .clear
        cornerRadius = 37
        tintColor = NSColor.white.withAlphaComponent(0.08)
        autoresizingMask = [.width, .height]

        let contentHost = NSView(frame: CGRect(origin: .zero, size: frameRect.size))
        contentHost.autoresizingMask = [.width, .height]
        contentView = contentHost
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}
