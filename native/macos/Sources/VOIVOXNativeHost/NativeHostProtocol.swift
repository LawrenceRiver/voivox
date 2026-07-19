import Foundation

let VOIVOXNativeHostIdentity = "com.voivox.bridge"
typealias NativeProofVerifier = (NativeConnection) -> Bool

struct NativeDiscoveryRequest: Equatable {
    let protocolVersion: Int
    let type: String

    static func parse(_ data: Data) throws -> NativeDiscoveryRequest {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            Set(dictionary.keys) == Set(["protocolVersion", "type"]),
            dictionary["protocolVersion"] as? Int == 1,
            dictionary["type"] as? String == "discover"
        else {
            throw NativeHostError.unsupportedRequest
        }
        return NativeDiscoveryRequest(protocolVersion: 1, type: "discover")
    }
}

struct NativeConnection: Equatable {
    enum LocalAsr: String {
        case checking
        case ready
        case missing
    }

    let baseUrl: String
    let token: String
    let localAsr: LocalAsr

    static func parse(_ data: Data) throws -> NativeConnection {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            dictionary["service"] as? String == "voivox",
            dictionary["status"] as? String == "ready",
            let baseUrl = dictionary["baseUrl"] as? String,
            isExactLoopbackBaseUrl(baseUrl),
            let token = dictionary["token"] as? String,
            isValidToken(token),
            let capabilities = dictionary["capabilities"] as? [String: Any],
            let localAsrValue = capabilities["localAsr"] as? String,
            let localAsr = LocalAsr(rawValue: localAsrValue)
        else {
            throw NativeHostError.invalidConnection
        }

        return NativeConnection(baseUrl: baseUrl, token: token, localAsr: localAsr)
    }

    private static func isExactLoopbackBaseUrl(_ value: String) -> Bool {
        let prefix = "http://127.0.0.1:"
        guard value.hasPrefix(prefix) else { return false }
        let portText = String(value.dropFirst(prefix.count))
        guard
            !portText.isEmpty,
            portText.allSatisfy(\.isNumber),
            let port = Int(portText),
            (1...65_535).contains(port)
        else {
            return false
        }
        return value == "\(prefix)\(port)"
    }

    private static func isValidToken(_ token: String) -> Bool {
        !token.isEmpty
            && token.utf8.count <= 16_384
            && token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
            && token.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
}

enum NativeConnectionFile {
    static func path(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> URL {
        if let override = environment["VOIVOX_EXTENSION_CONNECTION_FILE"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        return homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("Voice Vac", isDirectory: true)
            .appendingPathComponent("extension-connection.json", isDirectory: false)
    }

    static func load() throws -> Data {
        try Data(contentsOf: path(), options: [.mappedIfSafe])
    }
}

enum NativeHostProcessor {
    static func response(
        for requestData: Data,
        loadConnection: () throws -> Data = NativeConnectionFile.load,
        verifyConnection: NativeProofVerifier = { connection in
            NativeServerProof.verify(connection)
        }
    ) -> Data {
        do {
            _ = try NativeDiscoveryRequest.parse(requestData)
        } catch {
            return errorResponse("unsupported_request")
        }

        let connectionData: Data
        do {
            connectionData = try loadConnection()
        } catch {
            return errorResponse("connection_unavailable")
        }

        let connection: NativeConnection
        do {
            connection = try NativeConnection.parse(connectionData)
        } catch {
            return errorResponse("invalid_connection")
        }
        guard verifyConnection(connection) else {
            return errorResponse("connection_unavailable")
        }

        return encode([
            "protocolVersion": 1,
            "service": "voivox",
            "status": "ready",
            "baseUrl": connection.baseUrl,
            "token": connection.token,
            "capabilities": ["localAsr": connection.localAsr.rawValue]
        ])
    }

    static func errorResponse(_ code: String) -> Data {
        encode([
            "protocolVersion": 1,
            "service": "voivox",
            "status": "error",
            "error": code
        ])
    }

    private static func encode(_ object: [String: Any]) -> Data {
        // Every call site builds a JSON-compatible dictionary from fixed keys and validated values.
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"protocolVersion":1,"service":"voivox","status":"error","error":"internal_error"}"#.utf8)
    }
}

enum NativeMessagingHost {
    static func run(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput,
        loadConnection: () throws -> Data = NativeConnectionFile.load,
        verifyConnection: NativeProofVerifier = { connection in
            NativeServerProof.verify(connection)
        }
    ) {
        while true {
            do {
                guard let request = try NativeMessageFraming.readMessage(from: input) else {
                    return
                }
                try NativeMessageFraming.writeMessage(
                    NativeHostProcessor.response(
                        for: request,
                        loadConnection: loadConnection,
                        verifyConnection: verifyConnection
                    ),
                    to: output
                )
            } catch {
                try? NativeMessageFraming.writeMessage(
                    NativeHostProcessor.errorResponse("invalid_native_message"),
                    to: output
                )
                return
            }
        }
    }
}
