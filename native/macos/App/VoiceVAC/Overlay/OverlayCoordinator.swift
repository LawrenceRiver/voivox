import AppKit
import Observation
import VoiceVACCore

@MainActor
final class OverlayCoordinator: WindowCoordinating, VoiceVACInteractionPresenting {
    enum AuxiliaryPresentation: Equatable {
        case hidden
        case transcript
        case urlInput
    }

    private struct DragContext {
        let pointerOrigin: CGPoint
        let capsuleOrigin: CGPoint
    }

    private let screenProvider: any ScreenProviding
    private let panelFactory: any PanelFactory
    private let layoutEngine: OverlayLayoutEngine
    private let placementStore: CapsulePlacementStore
    private let hoseRenderSession: HoseRenderSession?
    private var panels: [PanelRole: any PanelControlling] = [:]
    private var currentLayout: OverlayLayout?
    private var dragContext: DragContext?
    /// The nozzle owns a separate transparent macOS panel. Whether that panel
    /// is mechanically parked on the capsule is visual state, not a proxy for
    /// an ASR phase: warnings and transcript text can exist while the mouth is
    /// still docked.
    private var nozzleIsDocked = true
    private weak var store: VoiceVACStore?
    private(set) var auxiliaryPresentation = AuxiliaryPresentation.hidden
    private var isURLInputPresented = false
    private(set) var interactionRuntime: VoiceVACInteractionRuntime?

    init(
        screenProvider: any ScreenProviding,
        panelFactory: any PanelFactory,
        layoutEngine: OverlayLayoutEngine,
        placementStore: CapsulePlacementStore,
        hoseRenderSession: HoseRenderSession? = nil,
        interactionRuntime: VoiceVACInteractionRuntime? = nil
    ) {
        self.screenProvider = screenProvider
        self.panelFactory = panelFactory
        self.layoutEngine = layoutEngine
        self.placementStore = placementStore
        self.hoseRenderSession = hoseRenderSession
        self.interactionRuntime = interactionRuntime
            ?? (panelFactory as? LivePanelFactory)?.interactionRuntime
        self.interactionRuntime?.presenter = self
    }

    func start(with store: VoiceVACStore) {
        self.store = store
        screenProvider.onScreensChanged = { [weak self] in
            self?.reconcileScreens()
        }
        reconcileScreens()
        observeStoreState()
    }

    func setURLInputPresented(_ isPresented: Bool) {
        isURLInputPresented = isPresented
        synchronizePanelVisibility()
    }

    func panel(for role: PanelRole) -> (any PanelControlling)? {
        panels[role]
    }

    func moveNozzlePanel(
        center: CGPoint,
        hoseTangent: CGVector,
        showsCloseButton: Bool
    ) {
        guard let panel = panels[.nozzle] as? NozzleHitPanel else { return }
        nozzleIsDocked = false
        panel.setDeployed(
            center: center,
            hoseTangent: hoseTangent,
            showsCloseButton: showsCloseButton
        )
    }

    func dockNozzlePanel() {
        guard let frame = currentLayout?.nozzleHitFrame,
              let panel = panels[.nozzle] as? NozzleHitPanel
        else { return }
        nozzleIsDocked = true
        panel.setDocked(frame: frame)
    }

    func beginCapsuleDrag(at globalPoint: CGPoint) {
        guard let capsule = panels[.capsule] else { return }
        dragContext = DragContext(
            pointerOrigin: globalPoint,
            capsuleOrigin: capsule.frame.origin
        )
    }

    func dragCapsule(to globalPoint: CGPoint) {
        guard let dragContext, !screenProvider.screens.isEmpty else { return }
        let delta = CGPoint(
            x: globalPoint.x - dragContext.pointerOrigin.x,
            y: globalPoint.y - dragContext.pointerOrigin.y
        )
        let proposedFrame = CGRect(
            origin: CGPoint(
                x: dragContext.capsuleOrigin.x + delta.x,
                y: dragContext.capsuleOrigin.y + delta.y
            ),
            size: layoutEngine.metrics.capsuleSize
        )
        let targetScreen = screenForDrag(point: globalPoint, proposedFrame: proposedFrame)
        let placement = layoutEngine.placement(forCapsuleFrame: proposedFrame, on: targetScreen)
        let layout = layoutEngine.makeLayout(
            screens: screenProvider.screens,
            preferredScreenID: targetScreen.id,
            savedPlacement: placement
        )
        currentLayout = layout
        applyStaticFrames(from: layout)
    }

    func endCapsuleDrag(at globalPoint: CGPoint) {
        guard dragContext != nil else { return }
        dragCapsule(to: globalPoint)
        dragContext = nil

        guard let layout = currentLayout,
              let screen = screenProvider.screens.first(where: { $0.id == layout.capsuleScreenID })
        else { return }
        placementStore.save(
            layoutEngine.placement(forCapsuleFrame: layout.capsuleFrame, on: screen)
        )
    }

    private func reconcileScreens() {
        let screens = screenProvider.screens
        guard !screens.isEmpty else { return }

        let savedPlacement = placementStore.load()
        let layout = layoutEngine.makeLayout(
            screens: screens,
            preferredScreenID: screenProvider.preferredScreenID,
            savedPlacement: savedPlacement
        )
        currentLayout = layout

        removeObsoleteHosePanels(validScreenIDs: Set(screens.map(\.id)))
        createMissingPanels(for: layout)
        applyFrames(from: layout)
        rewriteCorrectedPlacementIfNeeded(savedPlacement, layout: layout, screens: screens)
        synchronizePanelVisibility()
    }

    private func removeObsoleteHosePanels(validScreenIDs: Set<ScreenID>) {
        let obsoleteRoles = panels.keys.filter { role in
            guard case let .hose(screenID) = role else { return false }
            return !validScreenIDs.contains(screenID)
        }
        for role in obsoleteRoles {
            guard let panel = panels.removeValue(forKey: role) else { continue }
            panel.orderOut()
            panel.close()
        }
    }

    private func createMissingPanels(for layout: OverlayLayout) {
        for (screenID, frame) in layout.hoseFrames where panels[.hose(screenID)] == nil {
            panels[.hose(screenID)] = panelFactory.makePanel(
                for: .hose(screenID),
                frame: frame,
                capsuleDragHandlers: nil
            )
        }

        let handlers = CapsuleDragHandlers(
            began: { [weak self] in self?.beginCapsuleDrag(at: $0) },
            changed: { [weak self] in self?.dragCapsule(to: $0) },
            ended: { [weak self] in self?.endCapsuleDrag(at: $0) }
        )
        createStaticPanelIfMissing(role: .capsule, frame: layout.capsuleFrame, handlers: handlers)
        createStaticPanelIfMissing(role: .nozzle, frame: layout.nozzleHitFrame)
        createStaticPanelIfMissing(role: .transcript, frame: layout.transcriptFrame)
        createStaticPanelIfMissing(role: .urlInput, frame: layout.transcriptFrame)
    }

    private func createStaticPanelIfMissing(
        role: PanelRole,
        frame: CGRect,
        handlers: CapsuleDragHandlers? = nil
    ) {
        guard panels[role] == nil else { return }
        panels[role] = panelFactory.makePanel(
            for: role,
            frame: frame,
            capsuleDragHandlers: handlers
        )
    }

    private func applyFrames(from layout: OverlayLayout) {
        for (screenID, frame) in layout.hoseFrames {
            panels[.hose(screenID)]?.setFrame(frame)
        }
        applyStaticFrames(from: layout)
    }

    private func applyStaticFrames(from layout: OverlayLayout) {
        panels[.capsule]?.setFrame(layout.capsuleFrame)
        if nozzleIsDocked {
            if let panel = panels[.nozzle] as? NozzleHitPanel {
                panel.setDocked(frame: layout.nozzleHitFrame)
            } else {
                panels[.nozzle]?.setFrame(layout.nozzleHitFrame)
            }
            interactionRuntime?.configureDock(frame: layout.nozzleHitFrame)
            do {
                try hoseRenderSession?.dock(in: layout.nozzleHitFrame)
            } catch {
                // HoseRenderSession has already surfaced this contract failure in every viewport.
            }
        } else {
            // The mouth remains attached to its page target; only its machine
            // end migrates with the capsule. Re-anchor the live XPBD rig so
            // the rendered tube continues to leave the new glass port.
            interactionRuntime?.configureDock(frame: layout.nozzleHitFrame)
            do {
                try hoseRenderSession?.reanchorExternalHose(to: layout.nozzleHitFrame)
            } catch {
                // Preserve the visible remote mouth if a screen move would
                // exceed the available physical hose length.
            }
        }
        panels[.transcript]?.setFrame(layout.transcriptFrame)
        panels[.urlInput]?.setFrame(layout.transcriptFrame)
    }

    private func rewriteCorrectedPlacementIfNeeded(
        _ savedPlacement: CapsulePlacement?,
        layout: OverlayLayout,
        screens: [ScreenDescriptor]
    ) {
        guard let savedPlacement,
              let activeScreen = screens.first(where: { $0.id == layout.capsuleScreenID })
        else { return }
        let corrected = layoutEngine.placement(forCapsuleFrame: layout.capsuleFrame, on: activeScreen)
        if corrected != savedPlacement {
            placementStore.save(corrected)
        }
    }

    private func synchronizePanelVisibility() {
        auxiliaryPresentation = resolvedAuxiliaryPresentation()
        let hoseRoles = panels.keys.compactMap { role -> (ScreenID, PanelRole)? in
            guard case let .hose(screenID) = role else { return nil }
            return (screenID, role)
        }.sorted { $0.0.rawValue < $1.0.rawValue }.map(\.1)
        let roles = hoseRoles + [.capsule, .nozzle, .transcript, .urlInput]
        for role in roles {
            guard let panel = panels[role] else { continue }
            if shouldShow(role) {
                panel.orderFrontRegardless()
            } else if panel.isVisible {
                panel.orderOut()
            }
        }
    }

    private func resolvedAuxiliaryPresentation() -> AuxiliaryPresentation {
        if isURLInputPresented {
            return .urlInput
        }
        guard let state = store?.state else { return .hidden }
        if state.phase == .transcribing
            || state.phase == .paused
            || state.phase == .completed
            || state.phase == .warningYellow
            || !state.transcriptPreview.isEmpty
        {
            return .transcript
        }
        return .hidden
    }

    private func shouldShow(_ role: PanelRole) -> Bool {
        switch role {
        case .hose, .capsule, .nozzle:
            true
        case .transcript:
            auxiliaryPresentation == .transcript
        case .urlInput:
            auxiliaryPresentation == .urlInput
        }
    }

    private func observeStoreState() {
        guard let store else { return }
        withObservationTracking {
            _ = store.state
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.interactionRuntime?.synchronize(with: store.state)
                self.synchronizePanelVisibility()
                self.observeStoreState()
            }
        }
    }

    private func screenForDrag(point: CGPoint, proposedFrame: CGRect) -> ScreenDescriptor {
        let screens = screenProvider.screens
        if let containingPointer = screens.first(where: { $0.frame.contains(point) }) {
            return containingPointer
        }
        if let containingCapsule = screens.first(where: { $0.frame.intersects(proposedFrame) }) {
            return containingCapsule
        }
        if let currentLayout,
           let current = screens.first(where: { $0.id == currentLayout.capsuleScreenID })
        {
            return current
        }
        return screens[0]
    }
}
