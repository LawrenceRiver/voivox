import Foundation

let VOIVOXNativeHostIdentity = "com.voivox.bridge"
typealias NativeProofVerifier = (NativeConnection) -> Bool

enum NativeHostRequest: Equatable {
    case discover
    case connect

    static func parse(_ data: Data) throws -> NativeHostRequest {
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            Set(dictionary.keys) == Set(["protocolVersion", "type"]),
            let protocolVersion = dictionary["protocolVersion"] as? Int,
            let type = dictionary["type"] as? String
        else {
            throw NativeHostError.unsupportedRequest
        }
        switch (protocolVersion, type) {
        case (1, "discover"):
            return .discover
        case (2, "connect"):
            return .connect
        default:
            throw NativeHostError.unsupportedRequest
        }
    }
}

struct NativeDiscoveryRequest: Equatable {
    let protocolVersion: Int
    let type: String

    static func parse(_ data: Data) throws -> NativeDiscoveryRequest {
        guard try NativeHostRequest.parse(data) == .discover else {
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

    static func isExactLoopbackBaseUrl(_ value: String) -> Bool {
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
        errorResponse(code, protocolVersion: 1)
    }

    static func errorResponse(_ code: String, protocolVersion: Int) -> Data {
        encode([
            "protocolVersion": protocolVersion,
            "service": "voivox",
            "status": "error",
            "error": code
        ])
    }

    static func connectedResponse() -> Data {
        encode([
            "protocolVersion": 2,
            "service": "voivox",
            "status": "connected"
        ])
    }

    private static func encode(_ object: [String: Any]) -> Data {
        // Every call site builds a JSON-compatible dictionary from fixed keys and validated values.
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data(#"{"protocolVersion":1,"service":"voivox","status":"error","error":"internal_error"}"#.utf8)
    }
}

enum NativeMessagingHost {
    typealias RelayCommands = (
        NativeConnection,
        FileHandle,
        @escaping () -> Bool
    ) throws -> Void

    static func run(
        input: FileHandle = .standardInput,
        output: FileHandle = .standardOutput,
        loadConnection: () throws -> Data = NativeConnectionFile.load,
        verifyConnection: NativeProofVerifier = { connection in
            NativeServerProof.verify(connection)
        },
        relayCommands: RelayCommands = { connection, output, shouldStop in
            try NativeCommandRelay().relay(
                connection: connection,
                output: output,
                shouldStop: shouldStop
            )
        }
    ) {
        while true {
            do {
                guard let request = try NativeMessageFraming.readMessage(from: input) else {
                    return
                }
                switch try NativeHostRequest.parse(request) {
                case .discover:
                    try NativeMessageFraming.writeMessage(
                        NativeHostProcessor.response(
                            for: request,
                            loadConnection: loadConnection,
                            verifyConnection: verifyConnection
                        ),
                        to: output
                    )
                case .connect:
                    let connectionData: Data
                    do {
                        connectionData = try loadConnection()
                    } catch {
                        try NativeMessageFraming.writeMessage(
                            NativeHostProcessor.errorResponse(
                                "connection_unavailable",
                                protocolVersion: 2
                            ),
                            to: output
                        )
                        return
                    }
                    let connection: NativeConnection
                    do {
                        connection = try NativeConnection.parse(connectionData)
                    } catch {
                        try NativeMessageFraming.writeMessage(
                            NativeHostProcessor.errorResponse("invalid_connection", protocolVersion: 2),
                            to: output
                        )
                        return
                    }
                    guard verifyConnection(connection) else {
                        try NativeMessageFraming.writeMessage(
                            NativeHostProcessor.errorResponse(
                                "connection_unavailable",
                                protocolVersion: 2
                            ),
                            to: output
                        )
                        return
                    }
                    try NativeMessageFraming.writeMessage(
                        NativeHostProcessor.connectedResponse(),
                        to: output
                    )
                    let lifetime = NativePortLifetime(input: input)
                    lifetime.start()
                    defer { lifetime.stop() }
                    do {
                        try relayCommands(connection, output) { lifetime.hasEnded }
                    } catch {
                        // A protocol-two relay failure closes the native port. Chrome
                        // reconnects and re-verifies the current connection file.
                    }
                    return
                }
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

final class NativePortLifetime: @unchecked Sendable {
    private let input: FileHandle
    private let lock = NSLock()
    private var ended = false
    private var notifications = 0

    init(input: FileHandle) {
        self.input = input
    }

    var hasEnded: Bool {
        lock.lock()
        defer { lock.unlock() }
        return ended
    }

    var notificationCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return notifications
    }

    func start() {
        input.readabilityHandler = { [weak self] handle in
            handle.readabilityHandler = nil
            _ = handle.availableData
            self?.markEnded()
        }
    }

    func stop() {
        input.readabilityHandler = nil
    }

    private func markEnded() {
        lock.lock()
        ended = true
        notifications += 1
        lock.unlock()
    }
}
