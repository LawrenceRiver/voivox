import AppKit

@MainActor
final class NozzleHitPanel: NSPanel, PanelControlling {
    static let dockedSize = CGSize(width: 96, height: 96)
    static let deployedSize = CGSize(width: 144, height: 144)

    let role = PanelRole.nozzle
    let nozzleRealityView: NozzleRealityView
    let interactionView: NozzleInteractionHitView
    let closeButton = NSButton(title: "×", target: nil, action: nil)
    private weak var interactionRuntime: VoiceVACInteractionRuntime?

    init(
        frame: CGRect,
        deviceController: VoiceVACDeviceInteractionController = VoiceVACDeviceInteractionController(),
        interactionRuntime: VoiceVACInteractionRuntime? = nil
    ) {
        self.interactionRuntime = interactionRuntime
        nozzleRealityView = NozzleRealityView(
            frame: CGRect(origin: .zero, size: Self.dockedSize),
            deviceController: deviceController
        )
        interactionView = NozzleInteractionHitView(
            frame: CGRect(origin: .zero, size: Self.dockedSize),
            interactionRuntime: interactionRuntime
        )
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)

        let root = NSView(frame: CGRect(origin: .zero, size: frame.size))
        root.autoresizingMask = [.width, .height]
        nozzleRealityView.autoresizingMask = []
        interactionView.autoresizingMask = []
        root.addSubview(nozzleRealityView)
        root.addSubview(interactionView)

        closeButton.isBordered = false
        closeButton.font = .systemFont(ofSize: 24, weight: .medium)
        closeButton.contentTintColor = .labelColor
        closeButton.target = self
        closeButton.action = #selector(requestRetraction)
        closeButton.frame.size = CGSize(width: 40, height: 40)
        closeButton.isHidden = true
        closeButton.setAccessibilityIdentifier("voice-vac-retract-nozzle")
        closeButton.setAccessibilityLabel("Retract nozzle")
        root.addSubview(closeButton)
        contentView = root
        layoutContent(nozzleCenter: CGPoint(x: frame.width / 2, y: frame.height / 2), tangent: CGVector(dx: 0, dy: 1))
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func setDeployed(center: CGPoint, hoseTangent: CGVector, showsCloseButton: Bool) {
        let size = Self.deployedSize
        setFrame(
            CGRect(
                x: center.x - size.width / 2,
                y: center.y - size.height / 2,
                width: size.width,
                height: size.height
            ),
            display: true
        )
        layoutContent(
            nozzleCenter: CGPoint(x: size.width / 2, y: size.height / 2),
            tangent: hoseTangent
        )
        closeButton.isHidden = !showsCloseButton
    }

    func setDocked(frame: CGRect) {
        setFrame(frame, display: true)
        layoutContent(
            nozzleCenter: CGPoint(x: frame.width / 2, y: frame.height / 2),
            tangent: CGVector(dx: 0, dy: 1)
        )
        closeButton.isHidden = true
    }

    private func layoutContent(nozzleCenter: CGPoint, tangent: CGVector) {
        let nozzleFrame = CGRect(
            x: nozzleCenter.x - Self.dockedSize.width / 2,
            y: nozzleCenter.y - Self.dockedSize.height / 2,
            width: Self.dockedSize.width,
            height: Self.dockedSize.height
        )
        nozzleRealityView.frame = nozzleFrame
        interactionView.frame = nozzleFrame
        let close = NozzleRetractionController.closeButtonPoint(
            nozzlePoint: nozzleCenter,
            hoseTangent: tangent
        )
        closeButton.frame.origin = CGPoint(
            x: close.x - closeButton.frame.width / 2,
            y: close.y - closeButton.frame.height / 2
        )
    }

    @objc private func requestRetraction() {
        Task { @MainActor [weak interactionRuntime] in
            try? await interactionRuntime?.requestRetraction()
        }
    }
}

@MainActor
final class NozzleInteractionHitView: NSView {
    private weak var interactionRuntime: VoiceVACInteractionRuntime?
    private var startedDragging = false

    init(frame frameRect: NSRect, interactionRuntime: VoiceVACInteractionRuntime?) {
        self.interactionRuntime = interactionRuntime
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.backgroundColor = nil
        setAccessibilityIdentifier("voice-vac-nozzle")
        setAccessibilityRole(.button)
        setAccessibilityLabel("Voice VAC nozzle")
    }

    override var isOpaque: Bool { false }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func mouseDown(with event: NSEvent) {
        startedDragging = false
        if event.clickCount == 2 {
            interactionRuntime?.beginURLInputAnimation()
        }
    }

    override func mouseDragged(with event: NSEvent) {
        guard !startedDragging, event.clickCount < 2, let interactionRuntime else { return }
        startedDragging = true
        _ = try? interactionRuntime.beginNozzleDrag(
            from: self,
            event: event,
            nozzleFrame: bounds
        )
    }
}
