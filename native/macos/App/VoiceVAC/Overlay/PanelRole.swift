import VoiceVACCore

enum PanelRole: Hashable {
    case hose(ScreenID)
    case capsule
    case nozzle
    case transcript

    var level: Int {
        switch self {
        case .hose: 5
        case .capsule: 4
        case .nozzle: 6
        case .transcript: 7
        }
    }
}
