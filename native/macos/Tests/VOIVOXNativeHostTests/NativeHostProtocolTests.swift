import Foundation
import CryptoKit
import Testing
@testable import VOIVOXNativeHost

@Suite("Voice Vac native discovery protocol")
struct NativeHostProtocolTests {
    @Test("uses the Chrome manifest host identity")
    func usesStableHostIdentity() {
        #expect(VOIVOXNativeHostIdentity == "com.voivox.bridge")
    }

    @Test("accepts only the version-one discover request")
    func acceptsDiscoverRequest() throws {
        let request = try NativeDiscoveryRequest.parse(
            Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8)
        )

        #expect(request.protocolVersion == 1)
        #expect(request.type == "discover")
    }

    @Test("rejects malformed, unsupported, and extended requests", arguments: [
        #"{"protocolVersion":2,"type":"discover"}"#,
        #"{"protocolVersion":1,"type":"connect"}"#,
        #"{"protocolVersion":1,"type":"discover","token":"steal-me"}"#,
        #"[]"#,
        #"not-json"#
    ])
    func rejectsUnsupportedRequests(json: String) {
        #expect(throws: NativeHostError.unsupportedRequest) {
            try NativeDiscoveryRequest.parse(Data(json.utf8))
        }
    }

    @Test("returns only the restricted extension connection")
    func returnsRestrictedConnection() throws {
        let connection = Data(#"""
        {
          "service":"voivox",
          "status":"ready",
          "baseUrl":"http://127.0.0.1:43817",
          "token":"restricted-extension-token",
          "primaryToken":"must-never-leave-the-file",
          "capabilities":{"localAsr":"ready","extensionDiscovery":true}
        }
        """#.utf8)

        let responseData = NativeHostProcessor.response(
            for: Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8),
            loadConnection: { connection },
            verifyConnection: { _ in true }
        )
        let response = try #require(
            JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        )
        let capabilities = try #require(response["capabilities"] as? [String: Any])

        #expect(response["protocolVersion"] as? Int == 1)
        #expect(response["service"] as? String == "voivox")
        #expect(response["status"] as? String == "ready")
        #expect(response["baseUrl"] as? String == "http://127.0.0.1:43817")
        #expect(response["token"] as? String == "restricted-extension-token")
        #expect(capabilities["localAsr"] as? String == "ready")
        #expect(response["primaryToken"] == nil)
        #expect(capabilities["extensionDiscovery"] == nil)
        #expect(String(decoding: responseData, as: UTF8.self).contains("must-never-leave") == false)
    }

    @Test("refuses a stale connection file when the server cannot prove liveness")
    func rejectsStaleConnection() throws {
        let secret = "restricted-token-must-not-leak"
        let connection = Data(#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"\#(secret)","capabilities":{"localAsr":"ready"}}"#.utf8)

        let responseData = NativeHostProcessor.response(
            for: Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8),
            loadConnection: { connection },
            verifyConnection: { _ in false }
        )
        let response = try #require(
            JSONSerialization.jsonObject(with: responseData) as? [String: Any]
        )

        #expect(response["status"] as? String == "error")
        #expect(response["error"] as? String == "connection_unavailable")
        #expect(response["token"] == nil)
        #expect(String(decoding: responseData, as: UTF8.self).contains(secret) == false)
    }

    @Test("verifies a fresh challenge without sending the connection token to the server")
    func verifiesLiveServerProof() throws {
        let challenge = String(repeating: "A", count: 43)
        let connection = NativeConnection(
            baseUrl: "http://127.0.0.1:43817",
            token: "restricted-extension-token",
            localAsr: .ready
        )
        var requestedURL: URL?
        var requestedTimeout: TimeInterval?

        let verified = NativeServerProof.verify(
            connection,
            generateChallenge: { challenge },
            fetchProof: { url, timeout in
                requestedURL = url
                requestedTimeout = timeout
                let message = Data(
                    "voivox-native-proof\n1\n\(challenge)\n\(connection.baseUrl)".utf8
                )
                let signature = Data(
                    HMAC<SHA256>.authenticationCode(
                        for: message,
                        using: SymmetricKey(data: Data(connection.token.utf8))
                    )
                )
                let proof = signature.base64EncodedString()
                    .replacingOccurrences(of: "+", with: "-")
                    .replacingOccurrences(of: "/", with: "_")
                    .replacingOccurrences(of: "=", with: "")
                return try JSONSerialization.data(withJSONObject: [
                    "baseUrl": connection.baseUrl,
                    "proof": proof,
                    "protocolVersion": 1,
                    "service": "voivox",
                    "status": "ready"
                ])
            }
        )

        #expect(verified)
        #expect(requestedURL?.scheme == "http")
        #expect(requestedURL?.host == "127.0.0.1")
        #expect(requestedURL?.port == 43_817)
        #expect(requestedURL?.path == "/v1/native/proof")
        #expect(URLComponents(url: try #require(requestedURL), resolvingAgainstBaseURL: false)?.queryItems == [
            URLQueryItem(name: "challenge", value: challenge)
        ])
        #expect(requestedURL?.absoluteString.contains(connection.token) == false)
        #expect(try #require(requestedTimeout) <= 1)
    }

    @Test("binds proof to the connection file port and rejects a relayed server response")
    func rejectsRelayedServerProof() throws {
        let challenge = String(repeating: "B", count: 43)
        let connection = NativeConnection(
            baseUrl: "http://127.0.0.1:43817",
            token: "restricted-extension-token",
            localAsr: .ready
        )
        let relayedBaseURL = "http://127.0.0.1:49152"
        let message = Data(
            "voivox-native-proof\n1\n\(challenge)\n\(relayedBaseURL)".utf8
        )
        let signature = Data(
            HMAC<SHA256>.authenticationCode(
                for: message,
                using: SymmetricKey(data: Data(connection.token.utf8))
            )
        ).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        let verified = NativeServerProof.verify(
            connection,
            generateChallenge: { challenge },
            fetchProof: { _, _ in
                try JSONSerialization.data(withJSONObject: [
                    "baseUrl": relayedBaseURL,
                    "proof": signature,
                    "protocolVersion": 1,
                    "service": "voivox",
                    "status": "ready"
                ])
            }
        )

        #expect(verified == false)
    }

    @Test("strictly rejects untrusted connection fields", arguments: [
        (#"{"service":"other","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"token","capabilities":{"localAsr":"ready"}}"#, "service"),
        (#"{"service":"voivox","status":"starting","baseUrl":"http://127.0.0.1:43817","token":"token","capabilities":{"localAsr":"ready"}}"#, "status"),
        (#"{"service":"voivox","status":"ready","baseUrl":"https://127.0.0.1:43817","token":"token","capabilities":{"localAsr":"ready"}}"#, "scheme"),
        (#"{"service":"voivox","status":"ready","baseUrl":"http://localhost:43817","token":"token","capabilities":{"localAsr":"ready"}}"#, "hostname"),
        (#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817/path","token":"token","capabilities":{"localAsr":"ready"}}"#, "path"),
        (#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:0","token":"token","capabilities":{"localAsr":"ready"}}"#, "port"),
        (#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"","capabilities":{"localAsr":"ready"}}"#, "token"),
        (#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"token","capabilities":{"localAsr":"cloud"}}"#, "localAsr")
    ])
    func rejectsUntrustedConnections(json: String, _label: String) {
        #expect(throws: NativeHostError.invalidConnection) {
            try NativeConnection.parse(Data(json.utf8))
        }
    }

    @Test("error replies are stable and never include secret file data")
    func redactsConnectionErrors() throws {
        let secret = "primary-secret-that-must-not-leak"

        let response = NativeHostProcessor.response(
            for: Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8),
            loadConnection: { throw NSError(domain: secret, code: 7) }
        )
        let object = try #require(JSONSerialization.jsonObject(with: response) as? [String: Any])

        #expect(object["protocolVersion"] as? Int == 1)
        #expect(object["service"] as? String == "voivox")
        #expect(object["status"] as? String == "error")
        #expect(object["error"] as? String == "connection_unavailable")
        #expect(String(decoding: response, as: UTF8.self).contains(secret) == false)
    }

    @Test("uses the Application Support connection file unless explicitly overridden")
    func resolvesConnectionFilePath() {
        let home = URL(fileURLWithPath: "/Users/tester", isDirectory: true)

        #expect(
            NativeConnectionFile.path(environment: [:], homeDirectory: home).path
                == "/Users/tester/Library/Application Support/Voice Vac/extension-connection.json"
        )
        #expect(
            NativeConnectionFile.path(
                environment: ["VOIVOX_EXTENSION_CONNECTION_FILE": "/private/tmp/voivox.json"],
                homeDirectory: home
            ).path == "/private/tmp/voivox.json"
        )
    }

    @Test("serves every framed stdin request in one native-host process")
    func servesConsecutiveInputMessages() throws {
        let request = Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8)
        let inputBytes = try NativeMessageFraming.frame(request) + NativeMessageFraming.frame(request)
        let connection = Data(#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"restricted-token","capabilities":{"localAsr":"checking"}}"#.utf8)
        let input = Pipe()
        let output = Pipe()
        try input.fileHandleForWriting.write(contentsOf: inputBytes)
        try input.fileHandleForWriting.close()

        NativeMessagingHost.run(
            input: input.fileHandleForReading,
            output: output.fileHandleForWriting,
            loadConnection: { connection },
            verifyConnection: { _ in true }
        )
        try output.fileHandleForWriting.close()
        let replies = try NativeMessageFraming.decodeAll(
            output.fileHandleForReading.readDataToEndOfFile()
        )

        #expect(replies.count == 2)
        for reply in replies {
            let object = try #require(JSONSerialization.jsonObject(with: reply) as? [String: Any])
            #expect(object["status"] as? String == "ready")
            #expect(object["token"] as? String == "restricted-token")
        }
    }
}
