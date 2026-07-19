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
    func makePanel(
        for role: PanelRole,
        frame: CGRect,
        capsuleDragHandlers: CapsuleDragHandlers?
    ) -> any PanelControlling {
        switch role {
        case let .hose(screenID):
            HoseOverlayPanel(screenID: screenID, frame: frame)
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
