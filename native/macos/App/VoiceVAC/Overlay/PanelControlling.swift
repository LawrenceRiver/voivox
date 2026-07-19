import AppKit

@MainActor
struct CapsuleDragHandlers {
    let began: (CGPoint) -> Void
    let changed: (CGPoint) -> Void
    let ended: (CGPoint) -> Void
}

@MainActor
protocol PanelControlling: AnyObject {
    var role: PanelRole { get }
    var frame: CGRect { get }
    var isVisible: Bool { get }

    func setFrame(_ frame: CGRect)
    func orderFrontRegardless()
    func orderOut()
    func close()
}

@MainActor
extension PanelControlling where Self: NSPanel {
    func setFrame(_ frame: CGRect) {
        setFrame(frame, display: true)
    }

    func orderOut() {
        orderOut(nil)
    }
}

@MainActor
func configureVoiceVACPanel(
    _ panel: NSPanel,
    role: PanelRole,
    hasShadow: Bool = false
) {
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hidesOnDeactivate = false
    panel.canHide = false
    panel.isFloatingPanel = true
    panel.level = NSWindow.Level(rawValue: role.level)
    panel.isReleasedWhenClosed = false
    panel.isExcludedFromWindowsMenu = true
    panel.animationBehavior = .none
    panel.hasShadow = hasShadow
    panel.collectionBehavior = [
        .canJoinAllApplications,
        .canJoinAllSpaces,
        .transient,
        .ignoresCycle,
        .fullScreenAuxiliary,
    ]
}
