import Testing
@testable import VOIVOXHost

@Test("silent process tap is the default behavior used by Voice Vac")
func silentProcessTapDoesNotKeepPlaybackAudible() {
    let configuration = ProcessTapConfiguration(pid: 42, mode: .silent)
    #expect(configuration.keepsPlaybackAudible == false)
}

@Test("audible process tap preserves local playback")
func audibleProcessTapKeepsPlaybackAudible() {
    let configuration = ProcessTapConfiguration(pid: 42, mode: .audible)
    #expect(configuration.keepsPlaybackAudible == true)
}
