import CoreGraphics
import Foundation
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC capsule placement persistence")
struct CapsulePlacementStoreTests {
    @Test("stores normalized placement in a caller-supplied defaults suite")
    func storesNormalizedPlacement() throws {
        let (defaults, suiteName) = try isolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = CapsulePlacementStore(defaults: defaults)
        let placement = CapsulePlacement(
            screenID: ScreenID(rawValue: 42),
            normalizedOrigin: CGPoint(x: 0.25, y: 0.75)
        )

        store.save(placement)

        #expect(CapsulePlacementStore.storageKey == "voicevac.overlay.capsule-placement.v1")
        #expect(store.load() == placement)
        #expect(defaults.data(forKey: CapsulePlacementStore.storageKey) != nil)
    }

    @Test("placement normalization is independent of absolute and negative screen coordinates")
    func normalizesAbsolutePlacement() {
        let screen = ScreenDescriptor(
            id: ScreenID(rawValue: 7),
            frame: CGRect(x: -1440, y: 25, width: 1440, height: 900),
            visibleFrame: CGRect(x: -1440, y: 25, width: 1440, height: 875),
            backingScaleFactor: 2
        )
        let horizontalTravel = screen.visibleFrame.width - 48 - 406
        let verticalTravel = screen.visibleFrame.height - 48 - 116
        let frame = CGRect(
            x: screen.visibleFrame.minX + 24 + (horizontalTravel * 0.25),
            y: screen.visibleFrame.minY + 24 + (verticalTravel * 0.75),
            width: 406,
            height: 116
        )

        let placement = OverlayLayoutEngine().placement(
            forCapsuleFrame: frame,
            on: screen
        )

        #expect(placement.screenID == screen.id)
        #expect(abs(placement.normalizedOrigin.x - 0.25) < 0.000_001)
        #expect(abs(placement.normalizedOrigin.y - 0.75) < 0.000_001)
    }

    @Test("malformed stored placement is discarded")
    func discardsMalformedPlacement() throws {
        let (defaults, suiteName) = try isolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set(Data("not-json".utf8), forKey: CapsulePlacementStore.storageKey)
        let store = CapsulePlacementStore(defaults: defaults)

        #expect(store.load() == nil)
        #expect(defaults.object(forKey: CapsulePlacementStore.storageKey) == nil)
    }

    @Test("clear removes only placement from the supplied suite")
    func clearsPlacement() throws {
        let (defaults, suiteName) = try isolatedDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }
        defaults.set("keep", forKey: "unrelated")
        let store = CapsulePlacementStore(defaults: defaults)
        store.save(
            CapsulePlacement(
                screenID: ScreenID(rawValue: 1),
                normalizedOrigin: .zero
            )
        )

        store.clear()

        #expect(store.load() == nil)
        #expect(defaults.string(forKey: "unrelated") == "keep")
    }

    private func isolatedDefaults() throws -> (UserDefaults, String) {
        let suiteName = "VoiceVACCoreTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        return (defaults, suiteName)
    }
}
