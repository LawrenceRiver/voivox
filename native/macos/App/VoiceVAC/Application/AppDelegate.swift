import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let environmentFactory: any AppEnvironmentFactory
    private(set) var environment: AppEnvironment?

    init(environmentFactory: any AppEnvironmentFactory = LiveAppEnvironmentFactory()) {
        self.environmentFactory = environmentFactory
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let environment = environmentFactory.makeEnvironment()
        self.environment = environment
        environment.start()
    }
}
