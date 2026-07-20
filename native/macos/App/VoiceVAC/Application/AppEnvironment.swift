import Foundation
import VoiceVACCore

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
    private let screenProvider: any ScreenProviding
    private let placementDefaults: UserDefaults
    private let sessionTokenProvider: (any CrossWindowSessionTokenProviding)?
    private let realityLoader: any RealityAssetLoading
    private let backendSupervisor: VoiceVACBackendSupervisor?

    init(
        screenProvider: any ScreenProviding = NSScreenProvider(),
        placementDefaults: UserDefaults = .standard,
        sessionTokenProvider: (any CrossWindowSessionTokenProviding)? = nil,
        realityLoader: any RealityAssetLoading = RealityAssetLoader(),
        backendSupervisor: VoiceVACBackendSupervisor? = VoiceVACBackendSupervisor()
    ) {
        self.screenProvider = screenProvider
        self.placementDefaults = placementDefaults
        self.sessionTokenProvider = sessionTokenProvider
        self.realityLoader = realityLoader
        self.backendSupervisor = backendSupervisor
    }

    func makeEnvironment() -> AppEnvironment {
        let store = VoiceVACStore()
        let hoseRenderSource = HoseRenderSnapshotSource()
        let hoseRenderSession = HoseRenderSession(source: hoseRenderSource)
        let deviceController = VoiceVACDeviceInteractionController(loader: realityLoader)
        let liveTransport = VoiceVACURLSessionTransport()
        let liveBridge: VoiceVACDesktopBridge? = if sessionTokenProvider == nil {
            VoiceVACDesktopBridge(
                store: store,
                connections: LiveVoiceVACDesktopConnectionProvider(transport: liveTransport),
                transport: liveTransport
            )
        } else {
            nil
        }
        let resolvedTokenProvider = sessionTokenProvider
            ?? liveBridge
            ?? UnavailableCrossWindowSessionTokenProvider()
        let interactionRuntime = VoiceVACInteractionRuntime(
            store: store,
            hoseSession: hoseRenderSession,
            deviceController: deviceController,
            sessionTokenProvider: resolvedTokenProvider,
            effectHandler: { [weak liveBridge] effect in
                await liveBridge?.handle(effect)
            }
        )
        let panelFactory = LivePanelFactory(
            hoseRenderSource: hoseRenderSource,
            store: store,
            deviceController: deviceController,
            interactionRuntime: interactionRuntime
        )
        let overlayCoordinator = OverlayCoordinator(
            screenProvider: screenProvider,
            panelFactory: panelFactory,
            layoutEngine: OverlayLayoutEngine(),
            placementStore: CapsulePlacementStore(defaults: placementDefaults),
            hoseRenderSession: hoseRenderSession,
            interactionRuntime: interactionRuntime
        )
        return AppEnvironment(
            store: store,
            statusItemController: StatusItemController(),
            windowCoordinator: overlayCoordinator,
            desktopBridge: liveBridge,
            backendSupervisor: backendSupervisor
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
    private let desktopBridge: VoiceVACDesktopBridge?
    private let backendSupervisor: VoiceVACBackendSupervisor?

    init(
        store: VoiceVACStore,
        statusItemController: any StatusItemControlling,
        windowCoordinator: any WindowCoordinating,
        desktopBridge: VoiceVACDesktopBridge? = nil,
        backendSupervisor: VoiceVACBackendSupervisor? = nil
    ) {
        self.store = store
        self.statusItemController = statusItemController
        self.windowCoordinator = windowCoordinator
        self.desktopBridge = desktopBridge
        self.backendSupervisor = backendSupervisor
    }

    func start() {
        backendSupervisor?.start()
        desktopBridge?.start()
        windowCoordinator.start(with: store)
    }

    func stop() {
        desktopBridge?.stop()
        backendSupervisor?.stop()
    }
}
