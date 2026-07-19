import Foundation

public struct CapsulePlacementStore {
    public static let storageKey = "voicevac.overlay.capsule-placement.v1"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public func load() -> CapsulePlacement? {
        guard let data = defaults.data(forKey: Self.storageKey) else {
            return nil
        }

        guard let placement = try? JSONDecoder().decode(CapsulePlacement.self, from: data) else {
            defaults.removeObject(forKey: Self.storageKey)
            return nil
        }

        return placement
    }

    public func save(_ placement: CapsulePlacement) {
        guard let data = try? JSONEncoder().encode(placement) else {
            return
        }
        defaults.set(data, forKey: Self.storageKey)
    }

    public func clear() {
        defaults.removeObject(forKey: Self.storageKey)
    }
}
