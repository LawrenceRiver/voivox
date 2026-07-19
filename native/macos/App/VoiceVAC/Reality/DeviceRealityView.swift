import AppKit
import RealityKit

@MainActor
final class DeviceRealityView: NSView {
    static let cameraDistance: Float = 1.12
    static let horizontalFieldOfViewDegrees: Float = 40
    static let deviceOffset = SIMD3<Float>.zero

    let realityView: TransparentARView
    let contractErrorLabel = NSTextField(labelWithString: "")
    private let loader: any RealityAssetLoading
    private var loadingTask: Task<Void, Never>?

    init(frame frameRect: NSRect, loader: any RealityAssetLoading = RealityAssetLoader()) {
        self.loader = loader
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
                let device = try await loader.loadDevice()
                device.position = Self.deviceOffset
                let anchor = AnchorEntity(world: .zero)
                anchor.addChild(device)

                let camera = PerspectiveCamera()
                camera.camera = PerspectiveCameraComponent(
                    near: 0.01,
                    far: 10,
                    fieldOfViewInDegrees: Self.horizontalFieldOfViewDegrees,
                    fieldOfViewOrientation: .horizontal
                )
                camera.position = SIMD3(0, 0, Self.cameraDistance)
                anchor.addChild(camera)

                let keyLight = DirectionalLight()
                keyLight.light.intensity = 8_500
                keyLight.look(
                    at: .zero,
                    from: SIMD3(-0.35, 0.55, 0.75),
                    relativeTo: anchor
                )
                anchor.addChild(keyLight)
                realityView.scene.addAnchor(anchor)
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

    private static func visibleMessage(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Voice VAC asset contract error: \(error)"
    }
}

@MainActor
final class TransparentARView: ARView {
    override var isOpaque: Bool { false }
}
