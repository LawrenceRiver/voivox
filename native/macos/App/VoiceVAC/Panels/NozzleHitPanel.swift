import AppKit

@MainActor
final class NozzleHitPanel: NSPanel, PanelControlling {
    static let dockedSize = CGSize(width: 96, height: 96)
    static let deployedSize = CGSize(width: 144, height: 144)
    static let urlInputSize = CGSize(width: 344, height: 168)

    let role = PanelRole.nozzle
    let nozzleRealityView: NozzleRealityView
    let interactionView: NozzleInteractionHitView
    let embeddedURLInputView: NozzleURLInputView
    let closeButton = NSButton(title: "×", target: nil, action: nil)
    private weak var interactionRuntime: VoiceVACInteractionRuntime?
    private var nozzleCenter: CGPoint
    private var hoseTangent = CGVector(dx: 0, dy: 1)
    private var showsCloseButton = false

    init(
        frame: CGRect,
        deviceController: VoiceVACDeviceInteractionController = VoiceVACDeviceInteractionController(),
        interactionRuntime: VoiceVACInteractionRuntime? = nil,
        onURLSubmit: @escaping (URL) -> Void = { _ in }
    ) {
        self.interactionRuntime = interactionRuntime
        nozzleCenter = CGPoint(x: frame.midX, y: frame.midY)
        nozzleRealityView = NozzleRealityView(
            frame: CGRect(origin: .zero, size: Self.dockedSize),
            deviceController: deviceController
        )
        interactionView = NozzleInteractionHitView(
            frame: CGRect(origin: .zero, size: Self.dockedSize),
            interactionRuntime: interactionRuntime
        )
        embeddedURLInputView = NozzleURLInputView(onSubmit: onURLSubmit)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role)

        let root = NSView(frame: CGRect(origin: .zero, size: frame.size))
        root.wantsLayer = true
        root.layer?.masksToBounds = true
        root.autoresizingMask = [.width, .height]
        nozzleRealityView.autoresizingMask = []
        interactionView.autoresizingMask = []
        root.addSubview(nozzleRealityView)
        root.addSubview(interactionView)

        embeddedURLInputView.isHidden = true
        root.addSubview(embeddedURLInputView)

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
        becomesKeyOnlyIfNeeded = true
        layoutContent(
            nozzleCenter: CGPoint(x: frame.width / 2, y: frame.height / 2),
            tangent: CGVector(dx: 0, dy: 1),
            presentationSize: Self.dockedSize
        )
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func setDeployed(center: CGPoint, hoseTangent: CGVector, showsCloseButton: Bool) {
        nozzleCenter = center
        self.hoseTangent = hoseTangent
        self.showsCloseButton = showsCloseButton
        let size = embeddedURLInputView.isHidden ? Self.deployedSize : Self.urlInputSize
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
            tangent: hoseTangent,
            presentationSize: size
        )
        closeButton.isHidden = !showsCloseButton
    }

    func setDocked(frame: CGRect) {
        nozzleCenter = CGPoint(x: frame.midX, y: frame.midY)
        hoseTangent = CGVector(dx: 0, dy: 1)
        showsCloseButton = false
        embeddedURLInputView.setPresented(false)
        setFrame(frame, display: true)
        layoutContent(
            nozzleCenter: CGPoint(x: frame.width / 2, y: frame.height / 2),
            tangent: CGVector(dx: 0, dy: 1),
            presentationSize: Self.dockedSize
        )
        closeButton.isHidden = true
    }

    /// The URL control lives on the widened duckbill itself. Expanding this
    /// transparent panel gives RealityKit room for the mouth and keeps the
    /// native text field directly over the 3D intake instead of creating a
    /// second floating speech bubble.
    func setEmbeddedURLInputPresented(_ presented: Bool) {
        embeddedURLInputView.setPresented(presented)
        let size = presented ? Self.urlInputSize : Self.deployedSize
        setFrame(
            CGRect(
                x: nozzleCenter.x - size.width / 2,
                y: nozzleCenter.y - size.height / 2,
                width: size.width,
                height: size.height
            ),
            display: true
        )
        layoutContent(
            nozzleCenter: CGPoint(x: size.width / 2, y: size.height / 2),
            tangent: hoseTangent,
            presentationSize: size
        )
        closeButton.isHidden = !showsCloseButton
        if presented {
            makeKey()
            makeFirstResponder(embeddedURLInputView.urlField)
        }
    }

    private func layoutContent(
        nozzleCenter: CGPoint,
        tangent: CGVector,
        presentationSize: CGSize
    ) {
        let nozzleFrame = CGRect(
            x: nozzleCenter.x - presentationSize.width / 2,
            y: nozzleCenter.y - presentationSize.height / 2,
            width: presentationSize.width,
            height: presentationSize.height
        )
        nozzleRealityView.frame = nozzleFrame
        interactionView.frame = nozzleFrame
        let inputSize = embeddedURLInputView.frame.size
        embeddedURLInputView.frame.origin = CGPoint(
            x: nozzleCenter.x - inputSize.width / 2,
            y: nozzleCenter.y - inputSize.height / 2
        )
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
        guard event.clickCount < 2, let interactionRuntime else { return }
        interactionRuntime.prepareVisualDeployment(at: NSEvent.mouseLocation)
        guard !startedDragging else { return }
        startedDragging = true
        _ = try? interactionRuntime.beginNozzleDrag(
            from: self,
            event: event,
            nozzleFrame: bounds
        )
    }
}
