import Foundation
import RealityKit

@MainActor
struct RealityAssetLoader: RealityAssetLoading {
    static let requiredDeviceNodes = [
        "VAC_DEVICE_ROOT", "VAC_PORT", "VAC_NOZZLE", "VAC_NOZZLE_TIP",
        "VAC_BUTTON_BASE", "VAC_BUTTON_CAP",
    ]

    let bundle: Bundle

    init(bundle: Bundle = .main) {
        self.bundle = bundle
    }

    func loadDevice() async throws -> Entity {
        guard let url = bundle.url(forResource: "VoiceVACDevice", withExtension: "usdz") else {
            throw RealityAssetError.missingResource("VoiceVACDevice.usdz")
        }
        let entity = try await Entity(contentsOf: url)
        try Self.validateDevice(entity)
        return entity
    }

    static func validateDevice(_ entity: Entity) throws {
        for name in Self.requiredDeviceNodes where entity.findEntity(named: name) == nil {
            throw RealityAssetError.missingNode(name)
        }
    }
}
