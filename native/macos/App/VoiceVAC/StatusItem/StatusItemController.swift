import AppKit

@MainActor
final class StatusItemController {
    private let statusItem: NSStatusItem

    init(statusBar: NSStatusBar = .system) {
        statusItem = statusBar.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "Voice VAC"
        statusItem.button?.toolTip = "Voice VAC"
    }
}
