import AppKit
import VoiceVACCore

enum CapsuleControlLayout {
    static let projection: DeviceControlProjection = {
        do {
            return try VoiceVACDevicePresentationDesign.makeControlProjection(
                viewport: OverlayMetrics.phaseOne.capsuleSize,
                hitTargetSize: OverlayMetrics.phaseOne.nozzleHitSize
            )
        } catch {
            preconditionFailure("Invalid Voice VAC capsule control projection: \(error)")
        }
    }()
}

@MainActor
final class CapsuleGlassView: NSGlassEffectView {
    let dragSurface: CapsuleDragSurfaceView
    let deviceRealityView: DeviceRealityView
    let physicalButton: PhysicalButtonView
    let glassEdgeView: CapsuleGlassEdgeView

    init(
        frame frameRect: NSRect,
        store: VoiceVACStore = VoiceVACStore(),
        deviceController: VoiceVACDeviceInteractionController = VoiceVACDeviceInteractionController(),
        interactionRuntime: VoiceVACInteractionRuntime? = nil
    ) {
        let contentHost = NSView(frame: CGRect(origin: .zero, size: frameRect.size))
        dragSurface = CapsuleDragSurfaceView(frame: contentHost.bounds)
        deviceRealityView = DeviceRealityView(
            frame: contentHost.bounds,
            deviceController: deviceController
        )
        physicalButton = PhysicalButtonView(
            store: store,
            deviceController: deviceController,
            actionHandler: interactionRuntime.map { runtime in
                { runtime.primaryButtonPressed() }
            }
        )
        glassEdgeView = CapsuleGlassEdgeView(frame: contentHost.bounds)
        super.init(frame: frameRect)

        style = .clear
        cornerRadius = 58
        tintColor = NSColor.white.withAlphaComponent(0.12)
        autoresizingMask = [.width, .height]

        contentHost.autoresizingMask = [.width, .height]
        deviceRealityView.autoresizingMask = [.width, .height]
        dragSurface.autoresizingMask = [.width, .height]
        contentHost.addSubview(deviceRealityView)
        contentHost.addSubview(dragSurface)
        physicalButton.frame = Self.buttonHitFrame
        contentHost.addSubview(physicalButton)
        glassEdgeView.autoresizingMask = [.width, .height]
        contentHost.addSubview(glassEdgeView)
        contentView = contentHost
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable")
    }
}

/// A two-tone optical edge around the native clear glass. The dark hairline survives
/// white webpages while the inset white catchlight remains visible over dark video.
/// It does not fill or frost the capsule and never participates in hit testing.
@MainActor
final class CapsuleGlassEdgeView: NSView {
    static let outerStrokeColor = NSColor.black.withAlphaComponent(0.16)
    static let innerStrokeColor = NSColor.white.withAlphaComponent(0.72)
    static let outerLineWidth: CGFloat = 1.25
    static let innerLineWidth: CGFloat = 1

    override var isOpaque: Bool { false }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        let outerRect = bounds.insetBy(dx: 0.75, dy: 0.75)
        let outerRadius = max(0, outerRect.height / 2)
        let outer = NSBezierPath(
            roundedRect: outerRect,
            xRadius: outerRadius,
            yRadius: outerRadius
        )
        outer.lineWidth = Self.outerLineWidth
        Self.outerStrokeColor.setStroke()
        outer.stroke()

        let innerRect = bounds.insetBy(dx: 2, dy: 2)
        let innerRadius = max(0, innerRect.height / 2)
        let inner = NSBezierPath(
            roundedRect: innerRect,
            xRadius: innerRadius,
            yRadius: innerRadius
        )
        inner.lineWidth = Self.innerLineWidth
        Self.innerStrokeColor.setStroke()
        inner.stroke()
    }
}

@MainActor
final class CapsuleDragSurfaceView: NSView {
    static let nozzleHitFrame = CapsuleControlLayout.projection.portHitFrame
    static let buttonHitFrame = CapsuleControlLayout.projection.buttonHitFrame

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

private extension CapsuleGlassView {
    static let buttonHitFrame = CapsuleControlLayout.projection.buttonHitFrame
}
