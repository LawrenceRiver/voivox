import XCTest

final class VoiceVACLaunchTests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAccessoryApplicationLaunchesAndRemainsAlive() {
        let app = XCUIApplication()
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()

        let becameRunning = app.wait(for: .runningForeground, timeout: 4)
            || app.state == .runningBackground
        XCTAssertTrue(becameRunning)
        XCTAssertNotEqual(app.state, .notRunning)

        app.terminate()
    }

    func testCoreThreeDControlsAreReachableThroughTransparentHitTargets() {
        let app = XCUIApplication()
        app.launchArguments += ["-ApplePersistenceIgnoreState", "YES"]
        app.launch()

        XCTAssertTrue(app.buttons["voice-vac-physical-button"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["voice-vac-nozzle"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.buttons["voice-vac-copy-transcript"].exists)

        app.terminate()
    }
}
