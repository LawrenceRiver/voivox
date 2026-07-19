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

    init(hoseRenderSource: HoseRenderSnapshotSource = HoseRenderSnapshotSource()) {
        self.hoseRenderSource = hoseRenderSource
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
            CapsulePanel(frame: frame, dragHandlers: capsuleDragHandlers)
        case .nozzle:
            NozzleHitPanel(frame: frame)
        case .transcript:
            TranscriptPanel(frame: frame)
        case .urlInput:
            URLInputPanel(frame: frame)
        }
    }
}
