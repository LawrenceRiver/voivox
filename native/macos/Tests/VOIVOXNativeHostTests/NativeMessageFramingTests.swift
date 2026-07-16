import Foundation
import Testing
@testable import VOIVOXNativeHost

@Suite("Chrome native-message framing")
struct NativeMessageFramingTests {
    @Test("frames JSON with a four-byte little-endian length")
    func framesLittleEndianLength() throws {
        let payload = Data(repeating: 0x61, count: 258)

        let framed = try NativeMessageFraming.frame(payload)

        #expect(Array(framed.prefix(4)) == [0x02, 0x01, 0x00, 0x00])
        #expect(framed.dropFirst(4) == payload)
    }

    @Test("decodes consecutive native messages without merging them")
    func decodesConsecutiveMessages() throws {
        let first = Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8)
        let second = Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8)
        let stream = try NativeMessageFraming.frame(first) + NativeMessageFraming.frame(second)

        let decoded = try NativeMessageFraming.decodeAll(stream)

        #expect(decoded == [first, second])
    }

    @Test("rejects truncated headers and payloads", arguments: [
        Data([0x01, 0x00, 0x00]),
        Data([0x04, 0x00, 0x00, 0x00, 0x7b])
    ])
    func rejectsTruncatedFrames(stream: Data) {
        #expect(throws: NativeHostError.truncatedMessage) {
            try NativeMessageFraming.decodeAll(stream)
        }
    }

    @Test("rejects messages larger than the native host safety limit")
    func rejectsOversizedMessages() {
        let oversizedHeader = Data([0x01, 0x00, 0x10, 0x00])

        #expect(throws: NativeHostError.messageTooLarge) {
            try NativeMessageFraming.decodeAll(oversizedHeader)
        }
    }
}
