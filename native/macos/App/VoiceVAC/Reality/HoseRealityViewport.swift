import AppKit
import MetalKit

struct HoseRendererContract: Equatable {
    let jointMatrixCount = 64
    let correctiveWeightCount = 2
    let usesPremultipliedAlpha = true
    let usesEnergyConservingMicrofacetLighting = true
    let colorPixelFormat: MTLPixelFormat = .bgra8Unorm_srgb
    let depthPixelFormat: MTLPixelFormat = .depth32Float
    let sourceRGBBlendFactor: MTLBlendFactor = .one
    let destinationRGBBlendFactor: MTLBlendFactor = .oneMinusSourceAlpha
    let sourceAlphaBlendFactor: MTLBlendFactor = .one
    let destinationAlphaBlendFactor: MTLBlendFactor = .oneMinusSourceAlpha
}

@MainActor
final class HoseRenderSnapshotSource {
    private final class WeakViewport {
        weak var value: HoseRealityViewport?
        init(_ value: HoseRealityViewport) { self.value = value }
    }

    private(set) var latest: HoseRenderSnapshot?
    private var viewports: [WeakViewport] = []

    init(initial: HoseRenderSnapshot? = nil) {
        latest = initial
    }

    func register(_ viewport: HoseRealityViewport) {
        viewports.removeAll { $0.value == nil }
        viewports.append(WeakViewport(viewport))
        if let latest {
            viewport.render(latest)
        }
    }

    func publish(_ snapshot: HoseRenderSnapshot) {
        latest = snapshot
        viewports.removeAll { viewport in
            guard let viewport = viewport.value else { return true }
            viewport.render(snapshot)
            return false
        }
    }

    func publishError(_ error: Error) {
        viewports.removeAll { viewport in
            guard let viewport = viewport.value else { return true }
            viewport.showContractError(error)
            return false
        }
    }
}

@MainActor
final class HoseRealityViewport: NSView {
    private(set) var metalView: MTKView?
    let contractErrorLabel = NSTextField(labelWithString: "")
    private(set) var projector: ScreenPointProjector
    private(set) var latestSnapshot: HoseRenderSnapshot?
    let rendererContract = HoseRendererContract()
    private var renderer: HoseMetalRenderer?

    init(
        frame frameRect: NSRect,
        screenFrame: CGRect,
        backingScaleFactor: CGFloat,
        assetLoader: () throws -> HoseMetalAsset = { try HoseMetalAsset.loadBundled() }
    ) {
        let projectionResult = Result {
            try ScreenPointProjector(
                screenFrame: screenFrame,
                backingScaleFactor: backingScaleFactor
            )
        }
        projector = (try? projectionResult.get()) ?? .unit
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.isOpaque = false

        contractErrorLabel.textColor = .systemRed
        contractErrorLabel.font = .monospacedSystemFont(ofSize: 12, weight: .semibold)
        contractErrorLabel.alignment = .center
        contractErrorLabel.maximumNumberOfLines = 3
        contractErrorLabel.frame = bounds.insetBy(
            dx: min(24, bounds.width / 2),
            dy: min(24, bounds.height / 2)
        )
        contractErrorLabel.autoresizingMask = [.width, .height]
        contractErrorLabel.isHidden = true

        do {
            projector = try projectionResult.get()
            let asset = try assetLoader()
            let view = TransparentMTKView(frame: bounds)
            view.autoresizingMask = [.width, .height]
            view.wantsLayer = true
            view.layer?.isOpaque = false
            view.clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
            view.colorPixelFormat = rendererContract.colorPixelFormat
            view.depthStencilPixelFormat = rendererContract.depthPixelFormat
            view.framebufferOnly = true
            view.enableSetNeedsDisplay = true
            view.isPaused = true
            let renderer = try HoseMetalRenderer(
                view: view,
                asset: asset,
                projector: projector,
                contract: rendererContract
            )
            view.delegate = renderer
            self.renderer = renderer
            metalView = view
            addSubview(view)
            addSubview(contractErrorLabel)
        } catch {
            contractErrorLabel.stringValue = Self.visibleMessage(for: error)
            contractErrorLabel.isHidden = false
            addSubview(contractErrorLabel)
        }
    }

    override var isOpaque: Bool { false }

    func render(_ snapshot: HoseRenderSnapshot) {
        latestSnapshot = snapshot
        renderer?.render(snapshot)
        if renderer != nil {
            contractErrorLabel.isHidden = true
        }
        metalView?.setNeedsDisplay(bounds)
    }

    func showContractError(_ error: Error) {
        contractErrorLabel.stringValue = Self.visibleMessage(for: error)
        contractErrorLabel.isHidden = false
    }

    func updateProjection(screenFrame: CGRect, backingScaleFactor: CGFloat) throws {
        let next = try ScreenPointProjector(
            screenFrame: screenFrame,
            backingScaleFactor: backingScaleFactor
        )
        projector = next
        renderer?.updateProjector(next)
        metalView?.setNeedsDisplay(bounds)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    private static func visibleMessage(for error: Error) -> String {
        if case let HoseMetalAssetError.missingResource(name) = error {
            return "Voice VAC asset contract error: missing \(name)."
        }
        return "Voice VAC renderer contract error: \(error)"
    }
}

enum HoseMetalRendererError: Error, LocalizedError {
    case metalUnavailable
    case commandQueueUnavailable
    case shaderCompilationFailed(String)
    case shaderFunctionMissing(String)
    case pipelineCreationFailed(String)
    case bufferCreationFailed(String)

    var errorDescription: String? {
        switch self {
        case .metalUnavailable: "Metal is unavailable."
        case .commandQueueUnavailable: "Metal command queue unavailable."
        case let .shaderCompilationFailed(message): "Metal shader failed: \(message)"
        case let .shaderFunctionMissing(name): "Metal shader function missing: \(name)."
        case let .pipelineCreationFailed(message): "Metal pipeline failed: \(message)"
        case let .bufferCreationFailed(name): "Metal buffer failed: \(name)."
        }
    }
}

private struct HoseFrameUniforms {
    var worldToClip: simd_float4x4
    var correctiveWeights: SIMD2<Float>
    /// x is the active material start (0...1); y maps the exported UV range
    /// back to that material coordinate. Keeping this in the frame lets the
    /// same game mesh expand across a desktop without showing its collapsed
    /// internal reservoir.
    var activeMaterialRange: SIMD2<Float>
    var baseColor: SIMD4<Float>
    var material: SIMD4<Float>
    var lightDirection: SIMD4<Float>
}

/// GPU resources for a single live, variable-length bellows mesh. The source
/// Blender mesh remains loaded for material/contract validation; this buffer
/// set is the runtime topology built from the XPBD path.
private struct LiveBellowsBuffers {
    let vertexBuffers: [Int: any MTLBuffer]
    let indexBuffer: any MTLBuffer
    let indexCount: Int
}

final class HoseMetalRenderer: NSObject, MTKViewDelegate {
    private static let pointsPerMeter: Float = 1_000
    private let device: any MTLDevice
    private let commandQueue: any MTLCommandQueue
    private let pipeline: any MTLRenderPipelineState
    private let depthState: any MTLDepthStencilState
    private let indexBuffer: any MTLBuffer
    private let indexCount: Int
    private let inverseBindMatrices: [simd_float4x4]
    private let material: HoseMetalAsset.Material
    private let materialVScale: Float
    private let buffers: [Int: any MTLBuffer]
    private let lock = NSLock()
    private var snapshot: HoseRenderSnapshot
    private var projector: ScreenPointProjector
    private var liveBellows: LiveBellowsBuffers?

    @MainActor
    init(
        view: MTKView,
        asset: HoseMetalAsset,
        projector: ScreenPointProjector,
        contract: HoseRendererContract
    ) throws {
        guard let device = view.device ?? MTLCreateSystemDefaultDevice() else {
            throw HoseMetalRendererError.metalUnavailable
        }
        view.device = device
        self.device = device
        guard let commandQueue = device.makeCommandQueue() else {
            throw HoseMetalRendererError.commandQueueUnavailable
        }
        self.commandQueue = commandQueue
        self.projector = projector
        inverseBindMatrices = asset.inverseBindMatrices
        material = asset.material
        let maximumMaterialV = asset.textureCoordinates.map(\.y).max() ?? 1
        materialVScale = 1 / max(maximumMaterialV, 0.000_1)
        indexCount = asset.indices.count
        snapshot = HoseRenderSnapshot(
            jointMatrices: asset.bindMatrices,
            correctiveWeights: .zero
        )

        func makeBuffer<T>(_ values: [T], _ name: String) throws -> any MTLBuffer {
            let length = values.count * MemoryLayout<T>.stride
            let buffer = values.withUnsafeBufferPointer { pointer in
                pointer.baseAddress.flatMap {
                    device.makeBuffer(bytes: $0, length: length, options: .storageModeShared)
                }
            }
            guard let buffer else {
                throw HoseMetalRendererError.bufferCreationFailed(name)
            }
            buffer.label = name
            return buffer
        }
        buffers = [
            0: try makeBuffer(asset.positions, "hose.positions"),
            1: try makeBuffer(asset.normals, "hose.normals"),
            2: try makeBuffer(asset.textureCoordinates, "hose.uv"),
            3: try makeBuffer(asset.jointIndices, "hose.jointIndices"),
            4: try makeBuffer(asset.jointWeights, "hose.jointWeights"),
            5: try makeBuffer(asset.correctiveDeltas[0], "hose.correctivePositive"),
            6: try makeBuffer(asset.correctiveDeltas[1], "hose.correctiveNegative"),
        ]
        indexBuffer = try makeBuffer(asset.indices, "hose.indices")

        let library: any MTLLibrary
        do {
            library = try device.makeDefaultLibrary(bundle: .main)
        } catch {
            throw HoseMetalRendererError.shaderCompilationFailed(error.localizedDescription)
        }
        guard let vertex = library.makeFunction(name: "voiceVacHoseVertex") else {
            throw HoseMetalRendererError.shaderFunctionMissing("voiceVacHoseVertex")
        }
        guard let fragment = library.makeFunction(name: "voiceVacHoseFragment") else {
            throw HoseMetalRendererError.shaderFunctionMissing("voiceVacHoseFragment")
        }
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.label = "Voice VAC transparent PBR hose"
        descriptor.vertexFunction = vertex
        descriptor.fragmentFunction = fragment
        descriptor.depthAttachmentPixelFormat = view.depthStencilPixelFormat
        let color = descriptor.colorAttachments[0]!
        color.pixelFormat = view.colorPixelFormat
        color.isBlendingEnabled = true
        color.rgbBlendOperation = .add
        color.alphaBlendOperation = .add
        color.sourceRGBBlendFactor = contract.sourceRGBBlendFactor
        color.destinationRGBBlendFactor = contract.destinationRGBBlendFactor
        color.sourceAlphaBlendFactor = contract.sourceAlphaBlendFactor
        color.destinationAlphaBlendFactor = contract.destinationAlphaBlendFactor
        do {
            pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
        } catch {
            throw HoseMetalRendererError.pipelineCreationFailed(error.localizedDescription)
        }
        let depthDescriptor = MTLDepthStencilDescriptor()
        depthDescriptor.depthCompareFunction = .less
        depthDescriptor.isDepthWriteEnabled = true
        guard let depthState = device.makeDepthStencilState(descriptor: depthDescriptor) else {
            throw HoseMetalRendererError.pipelineCreationFailed("depth state unavailable")
        }
        self.depthState = depthState
        super.init()
    }

    func render(_ snapshot: HoseRenderSnapshot) {
        // The skeleton asset has a fixed 64-bone reservoir; generating the
        // tube from the live XPBD path prevents an inactive section from
        // collapsing into a straight line when the user pulls the mouth.
        let mesh = snapshot.showsExternalHose
            ? (try? makeLiveBellows(from: snapshot.centerline))
            : nil
        lock.withLock {
            self.snapshot = snapshot
            self.liveBellows = mesh
        }
    }

    func updateProjector(_ projector: ScreenPointProjector) {
        lock.withLock { self.projector = projector }
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pass = view.currentRenderPassDescriptor,
              let drawable = view.currentDrawable,
              let commandBuffer = commandQueue.makeCommandBuffer(),
              let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: pass)
        else { return }
        let state = lock.withLock { (snapshot, projector, liveBellows) }
        guard state.0.showsExternalHose else {
            encoder.endEncoding()
            commandBuffer.present(drawable)
            commandBuffer.commit()
            return
        }
        let useLiveBellows = state.2 != nil
        let skinMatrices: [simd_float4x4] = useLiveBellows
            ? Array(repeating: matrix_identity_float4x4, count: 64)
            : zip(state.0.jointMatrices, inverseBindMatrices).map(*)
        var frame = HoseFrameUniforms(
            worldToClip: state.1.worldToClipMatrix(pointsPerMeter: Self.pointsPerMeter),
            correctiveWeights: state.0.correctiveWeights,
            activeMaterialRange: SIMD2(
                useLiveBellows ? 0 : state.0.activeMaterialStart,
                materialVScale
            ),
            baseColor: SIMD4(material.baseColor[0], material.baseColor[1], material.baseColor[2], material.baseColor[3]),
            material: SIMD4(material.metallic, material.roughness, material.coatWeight, material.coatRoughness),
            lightDirection: simd_normalize(SIMD4<Float>(-0.35, 0.72, 0.60, 0))
        )

        encoder.setRenderPipelineState(pipeline)
        encoder.setDepthStencilState(depthState)
        for index in 0...6 {
            encoder.setVertexBuffer(
                state.2?.vertexBuffers[index] ?? buffers[index],
                offset: 0,
                index: index
            )
        }
        encoder.setVertexBytes(
            skinMatrices,
            length: skinMatrices.count * MemoryLayout<simd_float4x4>.stride,
            index: 7
        )
        encoder.setVertexBytes(&frame, length: MemoryLayout<HoseFrameUniforms>.stride, index: 8)
        encoder.setFragmentBytes(&frame, length: MemoryLayout<HoseFrameUniforms>.stride, index: 0)
        encoder.drawIndexedPrimitives(
            type: .triangle,
            indexCount: state.2?.indexCount ?? indexCount,
            indexType: .uint32,
            indexBuffer: state.2?.indexBuffer ?? indexBuffer,
            indexBufferOffset: 0
        )
        encoder.endEncoding()
        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    private func makeLiveBellows(
        from centerline: [SIMD3<Float>]
    ) throws -> LiveBellowsBuffers? {
        let geometry = HoseBellowsGeometry.make(centerline: centerline)
        guard geometry.indices.count >= 3,
              !geometry.positions.isEmpty
        else { return nil }

        func makeBuffer<T>(_ values: [T], _ name: String) throws -> any MTLBuffer {
            let length = values.count * MemoryLayout<T>.stride
            let buffer = values.withUnsafeBufferPointer { pointer in
                pointer.baseAddress.flatMap {
                    device.makeBuffer(bytes: $0, length: length, options: .storageModeShared)
                }
            }
            guard let buffer else {
                throw HoseMetalRendererError.bufferCreationFailed(name)
            }
            buffer.label = name
            return buffer
        }

        let count = geometry.positions.count
        let joints = Array(repeating: SIMD2<UInt16>(0, 0), count: count)
        let weights = Array(repeating: SIMD2<Float>(1, 0), count: count)
        let zeroDeltas = Array(repeating: SIMD3<Float>.zero, count: count)
        return LiveBellowsBuffers(
            vertexBuffers: [
                0: try makeBuffer(geometry.positions, "liveBellows.positions"),
                1: try makeBuffer(geometry.normals, "liveBellows.normals"),
                2: try makeBuffer(geometry.textureCoordinates, "liveBellows.uv"),
                3: try makeBuffer(joints, "liveBellows.joints"),
                4: try makeBuffer(weights, "liveBellows.weights"),
                5: try makeBuffer(zeroDeltas, "liveBellows.correctivePositive"),
                6: try makeBuffer(zeroDeltas, "liveBellows.correctiveNegative"),
            ],
            indexBuffer: try makeBuffer(geometry.indices, "liveBellows.indices"),
            indexCount: geometry.indices.count
        )
    }

}

@MainActor
final class TransparentMTKView: MTKView {
    override var isOpaque: Bool { false }
}
