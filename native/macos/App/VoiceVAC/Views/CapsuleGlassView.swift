import AppKit

@MainActor
final class CapsuleGlassView: NSGlassEffectView {
    let dragSurface: CapsuleDragSurfaceView

    override init(frame frameRect: NSRect) {
        let contentHost = NSView(frame: CGRect(origin: .zero, size: frameRect.size))
        dragSurface = CapsuleDragSurfaceView(frame: contentHost.bounds)
        super.init(frame: frameRect)

        style = .clear
        cornerRadius = 58
        tintColor = NSColor.white.withAlphaComponent(0.08)
        autoresizingMask = [.width, .height]

        contentHost.autoresizingMask = [.width, .height]
        dragSurface.autoresizingMask = [.width, .height]
        contentHost.addSubview(dragSurface)
        contentView = contentHost
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}

@MainActor
final class CapsuleDragSurfaceView: NSView {
    static let nozzleHitFrame = CGRect(x: 10, y: 10, width: 96, height: 96)
    static let buttonHitFrame = CGRect(x: 300, y: 10, width: 96, height: 96)

    var handlers: CapsuleDragHandlers?
    private var isTrackingBackgroundDrag = false

    func canBeginDrag(at point: CGPoint) -> Bool {
        bounds.contains(point)
            && !Self.nozzleHitFrame.contains(point)
            && !Self.buttonHitFrame.contains(point)
    }

    override func mouseDown(with event: NSEvent) {
        let localPoint = convert(event.locationInWindow, from: nil)
        guard canBeginDrag(at: localPoint) else { return }
        isTrackingBackgroundDrag = true
        handlers?.began(NSEvent.mouseLocation)
    }

    override func mouseDragged(with event: NSEvent) {
        guard isTrackingBackgroundDrag else { return }
        handlers?.changed(NSEvent.mouseLocation)
    }

    override func mouseUp(with event: NSEvent) {
        guard isTrackingBackgroundDrag else { return }
        isTrackingBackgroundDrag = false
        handlers?.ended(NSEvent.mouseLocation)
    }
}
