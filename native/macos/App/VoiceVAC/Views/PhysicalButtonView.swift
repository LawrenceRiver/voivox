import AppKit
import Observation
import VoiceVACCore

/// A transparent 96-point hit target over the authored `VAC_BUTTON_CAP` mesh.
/// It never draws a second button; all visual travel happens on the USDZ entity.
@MainActor
final class PhysicalButtonView: NSControl {
    let store: VoiceVACStore
    let deviceController: VoiceVACDeviceInteractionController
    private let actionHandler: (() -> [VoiceVACEffect])?
    private var isPointerDown = false
    private var loadingTask: Task<Void, Never>?

    init(
        store: VoiceVACStore,
        deviceController: VoiceVACDeviceInteractionController,
        actionHandler: (() -> [VoiceVACEffect])? = nil
    ) {
        self.store = store
        self.deviceController = deviceController
        self.actionHandler = actionHandler
        super.init(frame: CGRect(x: 0, y: 0, width: 96, height: 96))
        wantsLayer = true
        layer?.backgroundColor = nil
        setAccessibilityIdentifier("voice-vac-physical-button")
        setAccessibilityRole(.button)
        setAccessibilityLabel("Start, pause, or continue transcription")
        loadingTask = Task { [weak self] in
            guard let self else { return }
            _ = try? await deviceController.loadMainDevice()
            synchronize()
        }
        observeStoreState()
    }

    deinit { loadingTask?.cancel() }
    override var isOpaque: Bool { false }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    @discardableResult
    func performPrimaryAction() -> [VoiceVACEffect] {
        let effects = actionHandler?() ?? store.send(.primaryButtonPressed)
        synchronize()
        return effects
    }

    func synchronize() {
        try? deviceController.synchronizeButton(for: store.state.phase)
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        isPointerDown = true
        try? deviceController.applyButtonPose(.buttonDown)
    }

    override func mouseUp(with event: NSEvent) {
        guard isPointerDown else { return }
        isPointerDown = false
        if bounds.contains(convert(event.locationInWindow, from: nil)) {
            _ = performPrimaryAction()
            sendAction(action, to: target)
        } else {
            synchronize()
        }
    }

    private func observeStoreState() {
        withObservationTracking {
            _ = store.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                synchronize()
                observeStoreState()
            }
        }
    }
}
