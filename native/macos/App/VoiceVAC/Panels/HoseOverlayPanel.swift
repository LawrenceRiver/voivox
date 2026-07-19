import AppKit
import VoiceVACCore

@MainActor
final class HoseOverlayPanel: NSPanel, PanelControlling {
    let role: PanelRole

    init(
        screenID: ScreenID,
        frame: CGRect,
        renderSource: HoseRenderSnapshotSource = HoseRenderSnapshotSource()
    ) {
        role = .hose(screenID)
        super.init(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        configureVoiceVACPanel(self, role: role, hasShadow: false)
        ignoresMouseEvents = true
        let scale = NSScreen.screens.first(where: { $0.frame == frame })?.backingScaleFactor ?? 1
        let viewport = HoseRealityViewport(
            frame: CGRect(origin: .zero, size: frame.size),
            screenFrame: frame,
            backingScaleFactor: scale
        )
        contentView = viewport
        renderSource.register(viewport)
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override func setFrame(_ frameRect: NSRect, display flag: Bool) {
        super.setFrame(frameRect, display: flag)
        guard let viewport = contentView as? HoseRealityViewport else { return }
        let scale = NSScreen.screens.first(where: { $0.frame == frameRect })?.backingScaleFactor ?? 1
        try? viewport.updateProjection(
            screenFrame: frameRect,
            backingScaleFactor: scale
        )
    }
}
