import VoiceVACCore

enum PanelRole: Hashable {
    case hose(ScreenID)
    case capsule
    case nozzle
    case transcript
    case urlInput

    var level: Int {
        switch self {
        case .hose: 3
        case .capsule: 4
        case .nozzle: 5
        case .transcript: 6
        case .urlInput: 7
        }
    }
}
