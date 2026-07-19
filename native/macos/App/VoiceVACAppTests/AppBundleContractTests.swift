import AppKit
import XCTest
@testable import Voice_VAC

@MainActor
final class AppBundleContractTests: XCTestCase {
    func testBundleContract() throws {
        let info = try XCTUnwrap(Bundle.main.infoDictionary)

        XCTAssertEqual(info["CFBundleDisplayName"] as? String, "Voice VAC")
        XCTAssertEqual(info["CFBundleIdentifier"] as? String, "io.voivox.app")
        XCTAssertEqual(info["CFBundleExecutable"] as? String, "VoiceVAC")
        XCTAssertEqual(info["CFBundlePackageType"] as? String, "APPL")
        XCTAssertEqual(info["LSUIElement"] as? Bool, true)
        XCTAssertEqual(info["LSMinimumSystemVersion"] as? String, "26.0")
        XCTAssertEqual(info["NSHighResolutionCapable"] as? Bool, true)
        XCTAssertEqual(info["NSPrincipalClass"] as? String, "NSApplication")
        XCTAssertEqual(NSApp.activationPolicy(), .accessory)
        XCTAssertFalse(NSApp.windows.contains { $0.styleMask.contains(.titled) })
    }

    func testAppDelegateBuildsRetainsAndStartsEnvironment() {
        let coordinator = WindowCoordinatorSpy()
        let expectedStore = VoiceVACStore()
        let statusItemController = StatusItemControllerSpy()
        var environment: AppEnvironment? = AppEnvironment(
            store: expectedStore,
            statusItemController: statusItemController,
            windowCoordinator: coordinator
        )
        weak var retainedEnvironment = environment
        let factory = AppEnvironmentFactorySpy(environment: environment!)
        let delegate = AppDelegate(environmentFactory: factory)

        delegate.applicationDidFinishLaunching(
            Notification(name: NSApplication.didFinishLaunchingNotification, object: NSApp)
        )

        XCTAssertEqual(factory.makeEnvironmentCallCount, 1)
        XCTAssertTrue(delegate.environment === environment)
        XCTAssertFalse(factory.isHoldingEnvironment)

        environment = nil

        XCTAssertNotNil(retainedEnvironment)
        guard let liveEnvironment = retainedEnvironment else { return }
        XCTAssertTrue(delegate.environment === liveEnvironment)
        XCTAssertEqual(coordinator.startedStores.count, 1)
        XCTAssertTrue(coordinator.startedStores.first === expectedStore)
    }
}

@MainActor
private final class AppEnvironmentFactorySpy: AppEnvironmentFactory {
    private var environment: AppEnvironment?
    private(set) var makeEnvironmentCallCount = 0
    var isHoldingEnvironment: Bool { environment != nil }

    init(environment: AppEnvironment) {
        self.environment = environment
    }

    func makeEnvironment() -> AppEnvironment {
        makeEnvironmentCallCount += 1
        guard let environment else {
            preconditionFailure("AppEnvironmentFactorySpy can only build one environment")
        }
        self.environment = nil
        return environment
    }
}

@MainActor
private final class WindowCoordinatorSpy: WindowCoordinating {
    private(set) var startedStores: [VoiceVACStore] = []

    func start(with store: VoiceVACStore) {
        startedStores.append(store)
    }
}

@MainActor
private final class StatusItemControllerSpy: StatusItemControlling {}
