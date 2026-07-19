import AppKit
import XCTest

@MainActor
final class AppBundleContractTests: XCTestCase {
    func testBundleContract() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)

        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "Voice VAC")
        XCTAssertEqual(info["CFBundleIdentifier"] as? String, "io.voivox.app")
        XCTAssertEqual(info["LSUIElement"] as? Bool, true)
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
        XCTAssertFalse(NSApp.windows.contains { $0.styleMask.contains(.titled) })
    }
}
