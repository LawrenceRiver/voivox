import Foundation

enum NativeHostError: Error, Equatable {
    case invalidConnection
    case messageTooLarge
    case truncatedMessage
    case unsupportedRequest
}

enum NativeMessageFraming {
    static let maximumMessageSize = 1_048_576

    static func frame(_ payload: Data) throws -> Data {
        guard payload.count <= maximumMessageSize else {
            throw NativeHostError.messageTooLarge
        }

        let length = UInt32(payload.count)
        var result = Data([
            UInt8(truncatingIfNeeded: length),
            UInt8(truncatingIfNeeded: length >> 8),
            UInt8(truncatingIfNeeded: length >> 16),
            UInt8(truncatingIfNeeded: length >> 24)
        ])
        result.append(payload)
        return result
    }

    static func decodeAll(_ stream: Data) throws -> [Data] {
        var messages: [Data] = []
        var offset = 0

        while offset < stream.count {
            guard stream.count - offset >= 4 else {
                throw NativeHostError.truncatedMessage
            }
            let length = messageLength(in: stream, at: offset)
            guard length <= maximumMessageSize else {
                throw NativeHostError.messageTooLarge
            }
            offset += 4
            guard stream.count - offset >= length else {
                throw NativeHostError.truncatedMessage
            }
            messages.append(stream.subdata(in: offset..<(offset + length)))
            offset += length
        }

        return messages
    }

    static func readMessage(from input: FileHandle) throws -> Data? {
        guard let header = try readExactly(4, from: input, allowCleanEOF: true) else {
            return nil
        }
        let length = messageLength(in: header, at: 0)
        guard length <= maximumMessageSize else {
            throw NativeHostError.messageTooLarge
        }
        return try readExactly(length, from: input, allowCleanEOF: false)
    }

    static func writeMessage(_ payload: Data, to output: FileHandle) throws {
        try output.write(contentsOf: frame(payload))
    }

    private static func messageLength(in data: Data, at offset: Int) -> Int {
        Int(data[offset])
            | (Int(data[offset + 1]) << 8)
            | (Int(data[offset + 2]) << 16)
            | (Int(data[offset + 3]) << 24)
    }

    private static func readExactly(
        _ count: Int,
        from input: FileHandle,
        allowCleanEOF: Bool
    ) throws -> Data? {
        var result = Data()
        while result.count < count {
            let chunk = try input.read(upToCount: count - result.count) ?? Data()
            if chunk.isEmpty {
                if allowCleanEOF && result.isEmpty {
                    return nil
                }
                throw NativeHostError.truncatedMessage
            }
            result.append(chunk)
        }
        return result
    }
}
