import Foundation

enum ProcessTapMode: String, Codable {
    case silent
    case audible
}

struct ProcessTapConfiguration: Codable, Equatable {
    let pid: Int32
    let mode: ProcessTapMode

    var keepsPlaybackAudible: Bool {
        mode == .audible
    }
}
