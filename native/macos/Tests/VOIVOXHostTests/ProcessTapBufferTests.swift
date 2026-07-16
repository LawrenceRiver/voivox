import CoreAudio
import Testing
@testable import VOIVOXHost

@Test("the process tap writes the aggregate device input buffer")
func processTapUsesInputBuffer() {
    let allocated = UnsafeMutablePointer<AudioBufferList>.allocate(capacity: 1)
    defer { allocated.deallocate() }
    let input = UnsafePointer(allocated)

    #expect(tapInputBuffer(input) == input)
    #expect(tapInputBuffer(nil) == nil)
}
