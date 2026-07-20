import AppKit

@MainActor
protocol PanelFactory: AnyObject {
    func makePanel(
        for role: PanelRole,
        frame: CGRect,
        capsuleDragHandlers: CapsuleDragHandlers?
    ) -> any PanelControlling
}

@MainActor
final class LivePanelFactory: PanelFactory {
    private let hoseRenderSource: HoseRenderSnapshotSource
    let store: VoiceVACStore
    let deviceController: VoiceVACDeviceInteractionController
    let interactionRuntime: VoiceVACInteractionRuntime

    init(
        hoseRenderSource: HoseRenderSnapshotSource = HoseRenderSnapshotSource(),
        store: VoiceVACStore? = nil,
        deviceController: VoiceVACDeviceInteractionController? = nil,
        interactionRuntime: VoiceVACInteractionRuntime? = nil
    ) {
        let resolvedStore = store ?? VoiceVACStore()
        let resolvedDevice = deviceController ?? VoiceVACDeviceInteractionController()
        self.hoseRenderSource = hoseRenderSource
        self.store = resolvedStore
        self.deviceController = resolvedDevice
        self.interactionRuntime = interactionRuntime ?? VoiceVACInteractionRuntime(
            store: resolvedStore,
            hoseSession: nil,
            deviceController: resolvedDevice,
            sessionTokenProvider: UnavailableCrossWindowSessionTokenProvider()
        )
    }

    func makePanel(
        for role: PanelRole,
        frame: CGRect,
        capsuleDragHandlers: CapsuleDragHandlers?
    ) -> any PanelControlling {
        switch role {
        case let .hose(screenID):
            HoseOverlayPanel(
                screenID: screenID,
                frame: frame,
                renderSource: hoseRenderSource
            )
        case .capsule:
            CapsulePanel(
                frame: frame,
                dragHandlers: capsuleDragHandlers,
                store: store,
                deviceController: deviceController,
                interactionRuntime: interactionRuntime
            )
        case .nozzle:
            NozzleHitPanel(
                frame: frame,
                deviceController: deviceController,
                interactionRuntime: interactionRuntime,
                onURLSubmit: { [weak interactionRuntime] url in
                    interactionRuntime?.submitURL(url)
                }
            )
        case .transcript:
            TranscriptPanel(frame: frame, store: store)
        }
    }
}
