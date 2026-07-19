import AppKit

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var environment: AppEnvironment?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)

        let store = VoiceVACStore()
        let statusItemController = StatusItemController()
        let windowCoordinator = LifecycleWindowCoordinator()
        let environment = AppEnvironment(
            store: store,
            statusItemController: statusItemController,
            windowCoordinator: windowCoordinator
        )

        self.environment = environment
        environment.windowCoordinator.start(with: environment.store)
    }
}
