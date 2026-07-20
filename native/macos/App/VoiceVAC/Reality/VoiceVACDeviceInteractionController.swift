import Foundation
import CoreGraphics
import RealityKit
import simd
import VoiceVACCore

enum VoiceVACDevicePose: String, CaseIterable {
    case buttonUp
    case buttonReady
    case buttonDown
    case buttonPaused
    case nozzleDocked
    case nozzleLiftRotate
    case nozzleDeployed
    case nozzleAttachmentCompression
}

enum VoiceVACDeviceInteractionError: Error, Equatable, LocalizedError {
    case missingPoseContract
    case missingPose(String)
    case missingEntity(String)

    var errorDescription: String? {
        switch self {
        case .missingPoseContract:
            "Voice VAC asset contract error: missing asset-contract.json."
        case let .missingPose(name):
            "Voice VAC asset contract error: missing named pose \(name)."
        case let .missingEntity(name):
            "Voice VAC asset contract error: missing node \(name)."
        }
    }
}

private struct RuntimeAssetContract: Decodable {
    let runtimePoseDelivery: RuntimePoseDelivery

    struct RuntimePoseDelivery: Decodable {
        let namedPoses: [String: NamedPose]
    }

    struct NamedPose: Decodable {
        let node: String
        let transform: AssetTransform
    }

    struct AssetTransform: Decodable {
        let translation: [Float]
        let rotationQuaternion: [Float]
        let scale: [Float]

        var realityTransform: Transform? {
            guard translation.count == 3,
                  rotationQuaternion.count == 4,
                  scale.count == 3
            else { return nil }
            return Transform(
                scale: SIMD3(scale[0], scale[1], scale[2]),
                rotation: simd_quatf(
                    ix: rotationQuaternion[1],
                    iy: rotationQuaternion[2],
                    iz: rotationQuaternion[3],
                    r: rotationQuaternion[0]
                ),
                translation: SIMD3(translation[0], translation[1], translation[2])
            )
        }
    }
}

/// Owns the authored game-prop entities used by the two transparent presentation panels.
/// The complete device stays in the capsule, but its authored nozzle is disabled there;
/// the nozzle panel renders a recursive clone of that exact USDZ subtree.
@MainActor
final class VoiceVACDeviceInteractionController {
    private let loader: any RealityAssetLoading
    private let poses: [VoiceVACDevicePose: Transform]
    private var template: Entity?
    private var templateTask: Task<Entity, Error>?

    private(set) var mainDeviceEntity: Entity?
    private(set) var nozzleEntity: Entity?
    private(set) var nozzlePresentationRootEntity: Entity?
    private(set) var buttonCapEntity: Entity?
    private(set) var readyLightEntity: Entity?

    init(
        loader: any RealityAssetLoading = RealityAssetLoader(),
        contractBundle: Bundle = .main
    ) {
        self.loader = loader
        self.poses = Self.loadPoses(bundle: contractBundle)
    }

    func loadMainDevice() async throws -> Entity {
        if let mainDeviceEntity { return mainDeviceEntity }
        let device = try await loadTemplate().clone(recursive: true)
        guard let embeddedNozzle = device.findEntity(named: "VAC_NOZZLE") else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_NOZZLE")
        }
        guard let buttonCap = device.findEntity(named: "VAC_BUTTON_CAP") else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_BUTTON_CAP")
        }

        embeddedNozzle.isEnabled = false
        mainDeviceEntity = device
        buttonCapEntity = buttonCap
        readyLightEntity = device.findEntity(named: "VAC_BUTTON_READY_LIGHT")
        try applyButtonPose(.buttonUp)
        return device
    }

    func loadNozzleClone() async throws -> Entity {
        if let nozzleEntity { return nozzleEntity }
        let device = try await loadTemplate()
        guard let authoredNozzle = device.findEntity(named: "VAC_NOZZLE") else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_NOZZLE")
        }
        let clone = authoredNozzle.clone(recursive: true)
        clone.isEnabled = true
        nozzleEntity = clone
        try applyNozzlePose(.nozzleDocked)
        return clone
    }

    func transform(for pose: VoiceVACDevicePose) -> Transform {
        guard let transform = poses[pose] else {
            preconditionFailure("Missing required Voice VAC named pose \(pose.rawValue)")
        }
        return transform
    }

    func applyButtonPose(_ pose: VoiceVACDevicePose) throws {
        guard [.buttonUp, .buttonReady, .buttonDown, .buttonPaused].contains(pose) else {
            throw VoiceVACDeviceInteractionError.missingPose(pose.rawValue)
        }
        guard let buttonCapEntity else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_BUTTON_CAP")
        }
        buttonCapEntity.transform = try requiredTransform(for: pose)
        readyLightEntity?.isEnabled = pose == .buttonReady
    }

    func synchronizeButton(for phase: VoiceVACPhase) throws {
        switch phase {
        case .ready:
            try applyButtonPose(.buttonReady)
        case .transcribing:
            try applyButtonPose(.buttonDown)
        case .paused:
            try applyButtonPose(.buttonPaused)
        case .idle, .dragging, .targetDetected, .tabAudioOnly,
                .completed, .retracting, .warningYellow:
            try applyButtonPose(.buttonUp)
        }
    }

    func applyNozzlePose(_ pose: VoiceVACDevicePose) throws {
        guard [.nozzleDocked, .nozzleLiftRotate, .nozzleDeployed,
               .nozzleAttachmentCompression].contains(pose)
        else { throw VoiceVACDeviceInteractionError.missingPose(pose.rawValue) }
        guard let nozzleEntity else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_NOZZLE")
        }
        nozzleEntity.transform = try requiredTransform(for: pose)
        recenterNozzlePresentation()
    }

    func applyNozzleDragProgress(
        _ rawProgress: CGFloat,
        hoseTangent: CGVector = CGVector(dx: 0, dy: -1)
    ) throws {
        guard let nozzleEntity else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_NOZZLE")
        }
        let progress = Float(min(max(rawProgress, 0), 1))
        let docked = try requiredTransform(for: .nozzleDocked)
        let deployed = try requiredTransform(for: .nozzleDeployed)
        var transformed = Self.interpolate(from: docked, to: deployed, progress: progress)
        let dragRotation = simd_quatf(
            angle: Float(NozzlePresentationKinematics.screenRotation(forHoseTangent: hoseTangent)),
            axis: SIMD3(0, 0, 1)
        )
        transformed.rotation = simd_normalize(transformed.rotation * dragRotation)
        nozzleEntity.transform = transformed
        recenterNozzlePresentation()
    }

    func applyURLAnimationFrame(_ frame: NozzleURLAnimationFrame) throws {
        guard let nozzleEntity else {
            throw VoiceVACDeviceInteractionError.missingEntity("VAC_NOZZLE")
        }
        let docked = try requiredTransform(for: .nozzleDocked)
        let lifted = try requiredTransform(for: .nozzleLiftRotate)
        let deployed = try requiredTransform(for: .nozzleDeployed)
        let authored: Transform
        switch frame.stage {
        case .unlockAndLift:
            authored = Self.interpolate(from: docked, to: lifted, progress: Float(frame.stageProgress))
        case .rotateInPlane:
            authored = lifted
        case .cExtension, .reverseSCurlAndInput:
            authored = Self.interpolate(from: lifted, to: deployed, progress: Float(frame.stageProgress))
        }
        var transformed = authored
        let extraRotation = simd_quatf(angle: Float(frame.mouthRotation), axis: SIMD3(0, 0, 1))
        transformed.rotation = simd_normalize(authored.rotation * extraRotation)
        nozzleEntity.transform = transformed
        recenterNozzlePresentation()
    }

    func bindNozzlePresentationRoot(_ root: Entity) {
        nozzlePresentationRootEntity = root
        recenterNozzlePresentation()
    }

    private func loadTemplate() async throws -> Entity {
        if let template { return template }
        if let templateTask {
            let loaded = try await templateTask.value
            template = loaded
            return loaded
        }
        let task = Task { @MainActor [loader] in
            try await loader.loadDevice()
        }
        templateTask = task
        do {
            let loaded = try await task.value
            template = loaded
            templateTask = nil
            return loaded
        } catch {
            templateTask = nil
            throw error
        }
    }

    private func requiredTransform(for pose: VoiceVACDevicePose) throws -> Transform {
        guard let transform = poses[pose] else {
            throw VoiceVACDeviceInteractionError.missingPose(pose.rawValue)
        }
        return transform
    }

    private func recenterNozzlePresentation() {
        guard let nozzleEntity, let nozzlePresentationRootEntity else { return }
        nozzlePresentationRootEntity.position = -nozzleEntity.position
    }

    private static func interpolate(
        from start: Transform,
        to end: Transform,
        progress: Float
    ) -> Transform {
        let t = min(max(progress, 0), 1)
        return Transform(
            scale: simd_mix(start.scale, end.scale, SIMD3(repeating: t)),
            rotation: simd_slerp(start.rotation, end.rotation, t),
            translation: simd_mix(start.translation, end.translation, SIMD3(repeating: t))
        )
    }

    private static func loadPoses(bundle: Bundle) -> [VoiceVACDevicePose: Transform] {
        guard let url = bundle.url(forResource: "asset-contract", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let contract = try? JSONDecoder().decode(RuntimeAssetContract.self, from: data)
        else { return [:] }

        return Dictionary(uniqueKeysWithValues: VoiceVACDevicePose.allCases.compactMap { pose in
            guard let transform = contract.runtimePoseDelivery.namedPoses[pose.rawValue]?.transform.realityTransform else {
                return nil
            }
            return (pose, transform)
        })
    }
}
