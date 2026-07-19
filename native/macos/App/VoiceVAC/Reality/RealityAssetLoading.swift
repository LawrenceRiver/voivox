import Foundation
import RealityKit

@MainActor
protocol RealityAssetLoading {
    func loadDevice() async throws -> Entity
}

enum RealityAssetError: Error, Equatable, LocalizedError {
    case missingResource(String)
    case missingNode(String)

    var errorDescription: String? {
        switch self {
        case let .missingResource(name):
            "Voice VAC asset contract error: missing \(name)."
        case let .missingNode(name):
            "Voice VAC asset contract error: missing node \(name)."
        }
    }
}
