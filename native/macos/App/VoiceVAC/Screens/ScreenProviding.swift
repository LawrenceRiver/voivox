import VoiceVACCore

@MainActor
protocol ScreenProviding: AnyObject {
    var screens: [ScreenDescriptor] { get }
    var preferredScreenID: ScreenID? { get }
    var onScreensChanged: (() -> Void)? { get set }
}
