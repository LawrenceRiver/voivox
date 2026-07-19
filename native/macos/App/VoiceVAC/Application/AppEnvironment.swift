@MainActor
protocol WindowCoordinating: AnyObject {
    func start(with store: VoiceVACStore)
}

@MainActor
final class LifecycleWindowCoordinator: WindowCoordinating {
    private weak var store: VoiceVACStore?

    func start(with store: VoiceVACStore) {
        self.store = store
    }
}

@MainActor
final class AppEnvironment {
    let store: VoiceVACStore
    let statusItemController: StatusItemController
    let windowCoordinator: any WindowCoordinating

    init(
        store: VoiceVACStore,
        statusItemController: StatusItemController,
        windowCoordinator: any WindowCoordinating
    ) {
        self.store = store
        self.statusItemController = statusItemController
        self.windowCoordinator = windowCoordinator
    }
}
