@MainActor
protocol WindowCoordinating: AnyObject {
    func start(with store: VoiceVACStore)
}

@MainActor
protocol AppEnvironmentFactory {
    func makeEnvironment() -> AppEnvironment
}

@MainActor
struct LiveAppEnvironmentFactory: AppEnvironmentFactory {
    func makeEnvironment() -> AppEnvironment {
        AppEnvironment(
            store: VoiceVACStore(),
            statusItemController: StatusItemController(),
            windowCoordinator: LifecycleWindowCoordinator()
        )
    }
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
    let statusItemController: any StatusItemControlling
    let windowCoordinator: any WindowCoordinating

    init(
        store: VoiceVACStore,
        statusItemController: any StatusItemControlling,
        windowCoordinator: any WindowCoordinating
    ) {
        self.store = store
        self.statusItemController = statusItemController
        self.windowCoordinator = windowCoordinator
    }

    func start() {
        windowCoordinator.start(with: store)
    }
}
