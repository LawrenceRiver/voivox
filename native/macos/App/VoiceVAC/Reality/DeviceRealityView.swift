import AppKit
import RealityKit
import VoiceVACCore

@MainActor
final class DeviceRealityView: NSView {
    static let horizontalFieldOfViewDegrees = VoiceVACDevicePresentationDesign.horizontalFieldOfViewDegrees
    static let fillFraction = VoiceVACDevicePresentationDesign.fillFraction

    let realityView: TransparentARView
    let contractErrorLabel = NSTextField(labelWithString: "")
    let deviceController: VoiceVACDeviceInteractionController
    private(set) var presentationFraming: DevicePresentationFraming?
    private var loadingTask: Task<Void, Never>?

    init(
        frame frameRect: NSRect,
        loader: any RealityAssetLoading = RealityAssetLoader(),
        deviceController: VoiceVACDeviceInteractionController? = nil
    ) {
        self.deviceController = deviceController
            ?? VoiceVACDeviceInteractionController(loader: loader)
        realityView = TransparentARView(frame: CGRect(origin: .zero, size: frameRect.size))
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false

        realityView.autoresizingMask = [.width, .height]
        realityView.wantsLayer = true
        realityView.layer?.isOpaque = false
        realityView.environment.background = .color(.clear)
        addSubview(realityView)

        contractErrorLabel.textColor = .systemRed
        contractErrorLabel.font = .systemFont(ofSize: 9, weight: .semibold)
        contractErrorLabel.alignment = .center
        contractErrorLabel.maximumNumberOfLines = 2
        contractErrorLabel.frame = bounds.insetBy(dx: 8, dy: 8)
        contractErrorLabel.autoresizingMask = [.width, .height]
        contractErrorLabel.isHidden = true
        addSubview(contractErrorLabel)

        loadingTask = Task { [weak self] in
            guard let self else { return }
            do {
                let device = try await self.deviceController.loadMainDevice()
                let framing = try Self.framing(
                    entity: device,
                    viewport: frameRect.size
                )
                presentationFraming = framing
                realityView.installVoiceVACScene(entity: device, framing: framing)
            } catch {
                contractErrorLabel.stringValue = Self.visibleMessage(for: error)
                contractErrorLabel.isHidden = false
            }
        }
    }

    deinit { loadingTask?.cancel() }

    override var isOpaque: Bool { false }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    fileprivate static func visibleMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Voice VAC asset contract error: \(error)"
    }

    static func framing(
        entity: Entity,
        viewport: CGSize
    ) throws -> DevicePresentationFraming {
        return try DevicePresentationFraming.fit(
            bounds: activeVisualBounds(entity: entity),
            viewport: viewport,
            horizontalFieldOfViewDegrees: horizontalFieldOfViewDegrees,
            fillFraction: fillFraction
        )
    }

    /// `Entity.visualBounds(excludeInactive: true)` treats an unattached RealityKit
    /// hierarchy as inactive and returns a zero-sized box. Walk the authored model
    /// components instead so disabled presentation subtrees (the docked nozzle and
    /// ready light) are excluded without losing every visible control. World-space
    /// bounds deliberately include a detached presentation root's recenter transform,
    /// matching the coordinates used once that root is attached to the scene anchor.
    static func activeVisualBounds(entity: Entity) -> DeviceVisualBounds {
        var minimum = SIMD3<Float>(repeating: .infinity)
        var maximum = SIMD3<Float>(repeating: -.infinity)

        func visit(_ current: Entity, ancestorsEnabled: Bool) {
            let isVisible = ancestorsEnabled && current.isEnabled
            guard isVisible else { return }

            if current.components[ModelComponent.self] != nil {
                let bounds = current.visualBounds(
                    recursive: false,
                    relativeTo: nil,
                    excludeInactive: false
                )
                minimum = simd_min(minimum, bounds.min)
                maximum = simd_max(maximum, bounds.max)
            }
            for child in current.children {
                visit(child, ancestorsEnabled: isVisible)
            }
        }

        visit(entity, ancestorsEnabled: true)
        return DeviceVisualBounds(minimum: minimum, maximum: maximum)
    }
}

@MainActor
final class NozzleRealityView: NSView {
    let realityView: TransparentARView
    let contractErrorLabel = NSTextField(labelWithString: "")
    let deviceController: VoiceVACDeviceInteractionController
    private(set) var presentationFraming: DevicePresentationFraming?
    private var loadingTask: Task<Void, Never>?

    init(frame frameRect: NSRect, deviceController: VoiceVACDeviceInteractionController) {
        self.deviceController = deviceController
        realityView = TransparentARView(frame: CGRect(origin: .zero, size: frameRect.size))
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false

        realityView.autoresizingMask = [.width, .height]
        realityView.environment.background = .color(.clear)
        addSubview(realityView)

        contractErrorLabel.textColor = .systemRed
        contractErrorLabel.font = .systemFont(ofSize: 8, weight: .semibold)
        contractErrorLabel.alignment = .center
        contractErrorLabel.maximumNumberOfLines = 2
        contractErrorLabel.frame = bounds.insetBy(dx: 4, dy: 4)
        contractErrorLabel.autoresizingMask = [.width, .height]
        contractErrorLabel.isHidden = true
        addSubview(contractErrorLabel)

        loadingTask = Task { [weak self] in
            guard let self else { return }
            do {
                let nozzle = try await deviceController.loadNozzleClone()
                let presentationRoot = Entity()
                presentationRoot.name = "VAC_NOZZLE_PRESENTATION_ROOT"
                presentationRoot.addChild(nozzle)
                deviceController.bindNozzlePresentationRoot(presentationRoot)
                let framing = try DeviceRealityView.framing(
                    entity: presentationRoot,
                    viewport: frameRect.size
                )
                presentationFraming = framing
                realityView.installVoiceVACScene(entity: presentationRoot, framing: framing)
            } catch {
                contractErrorLabel.stringValue = DeviceRealityView.visibleMessage(for: error)
                contractErrorLabel.isHidden = false
            }
        }
    }

    deinit { loadingTask?.cancel() }
    override var isOpaque: Bool { false }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

@MainActor
final class TransparentARView: ARView {
    override var isOpaque: Bool { false }

    func installVoiceVACScene(
        entity: Entity,
        framing: DevicePresentationFraming
    ) {
        let anchor = AnchorEntity(world: .zero)
        anchor.addChild(entity)

        let camera = PerspectiveCamera()
        camera.camera = PerspectiveCameraComponent(
            near: 0.01,
            far: 10,
            fieldOfViewInDegrees: DeviceRealityView.horizontalFieldOfViewDegrees,
            fieldOfViewOrientation: .horizontal
        )
        camera.look(
            at: framing.lookAtPosition,
            from: framing.cameraPosition,
            relativeTo: anchor
        )
        anchor.addChild(camera)

        let keyLight = DirectionalLight()
        keyLight.light.intensity = 8_500
        keyLight.look(
            at: .zero,
            from: SIMD3(-0.35, 0.55, 0.75),
            relativeTo: anchor
        )
        anchor.addChild(keyLight)
        scene.addAnchor(anchor)
    }
}
