import AppKit
import Foundation

enum NozzlePasteboardError: Error, Equatable {
    case invalidNonceLength
    case invalidToken
    case pasteboardWriteFailed
}

struct NozzleDragToken: Equatable {
    static let prefix = "VOICE_VAC_DROP_V1"

    let sessionID: UUID
    let nonce: Data
    private let exactEncoding: String

    var encoded: String {
        exactEncoding
    }

    private static func encode(sessionID: UUID, nonce: Data) -> String {
        let nonceValue = nonce.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return "\(Self.prefix)|\(sessionID.uuidString.lowercased())|\(nonceValue)"
    }

    init(sessionID: UUID, nonce: Data) throws {
        guard nonce.count == 32 else { throw NozzlePasteboardError.invalidNonceLength }
        self.sessionID = sessionID
        self.nonce = nonce
        self.exactEncoding = Self.encode(sessionID: sessionID, nonce: nonce)
    }

    init(encoded: String) throws {
        let components = encoded.split(separator: "|", omittingEmptySubsequences: false)
        let uuidText = String(components.count > 1 ? components[1] : "")
        let v4Pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
        guard components.count == 3,
              components[0] == Substring(Self.prefix),
              uuidText.range(of: v4Pattern, options: [.regularExpression, .caseInsensitive]) != nil,
              let sessionID = UUID(uuidString: uuidText),
              components[2].count == 43,
              String(components[2]).range(
                  of: "^[A-Za-z0-9_-]{43}$",
                  options: .regularExpression
              ) != nil
        else { throw NozzlePasteboardError.invalidToken }

        var base64 = String(components[2])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        guard let nonce = Data(base64Encoded: base64), nonce.count == 32 else {
            throw NozzlePasteboardError.invalidToken
        }
        self.sessionID = sessionID
        self.nonce = nonce
        self.exactEncoding = encoded
    }
}

enum NozzlePasteboard {
    static func writeToken(
        sessionID: UUID,
        nonce: Data,
        to pasteboard: NSPasteboard
    ) throws -> String {
        let token = try NozzleDragToken(sessionID: sessionID, nonce: nonce).encoded
        pasteboard.clearContents()
        guard pasteboard.setString(token, forType: .string) else {
            throw NozzlePasteboardError.pasteboardWriteFailed
        }
        return token
    }

    static func makePasteboardItem(sessionID: UUID, nonce: Data) throws -> NSPasteboardItem {
        try makePasteboardItem(token: NozzleDragToken(sessionID: sessionID, nonce: nonce))
    }

    static func makePasteboardItem(token: NozzleDragToken) throws -> NSPasteboardItem {
        let item = NSPasteboardItem()
        guard item.setString(token.encoded, forType: .string) else {
            throw NozzlePasteboardError.pasteboardWriteFailed
        }
        return item
    }

    static func parse(_ token: String) throws -> NozzleDragToken {
        try NozzleDragToken(encoded: token)
    }
}
