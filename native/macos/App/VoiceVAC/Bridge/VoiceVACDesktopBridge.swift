import CryptoKit
import Foundation
import VoiceVACCore

struct VoiceVACHTTPResponse: Sendable {
    let data: Data
    let statusCode: Int
    let url: URL?

    init(data: Data, statusCode: Int, url: URL? = nil) {
        self.data = data
        self.statusCode = statusCode
        self.url = url
    }
}

@MainActor
protocol VoiceVACBridgeTransport: AnyObject {
    func send(_ request: URLRequest) async throws -> VoiceVACHTTPResponse
}

@MainActor
final class VoiceVACURLSessionTransport: VoiceVACBridgeTransport {
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        session = URLSession(
            configuration: configuration,
            delegate: VoiceVACNoRedirectDelegate(),
            delegateQueue: nil
        )
    }

    func send(_ request: URLRequest) async throws -> VoiceVACHTTPResponse {
        let (data, response) = try await session.data(for: request)
        guard
            let response = response as? HTTPURLResponse,
            response.url == request.url
        else {
            throw VoiceVACDesktopBridgeError.invalidResponse
        }
        return VoiceVACHTTPResponse(
            data: data,
            statusCode: response.statusCode,
            url: response.url
        )
    }
}

private final class VoiceVACNoRedirectDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

struct VoiceVACDesktopConnection: Equatable, Sendable {
    let baseURL: URL
    let token: String

    init(data: Data) throws {
        guard
            let value = try? JSONSerialization.jsonObject(with: data),
            let object = value as? [String: Any],
            Set(object.keys) == Set(["baseUrl", "token"]),
            let baseURLText = object["baseUrl"] as? String,
            let baseURL = URL(string: baseURLText),
            Self.isExactLoopback(baseURL),
            let token = object["token"] as? String,
            !token.isEmpty,
            token.utf8.count <= 16_384,
            token.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
        else {
            throw VoiceVACDesktopBridgeError.invalidConnection
        }
        self.baseURL = baseURL
        self.token = token
    }

    init(baseURL: URL, token: String) {
        self.baseURL = baseURL
        self.token = token
    }

    static func isExactLoopback(_ url: URL) -> Bool {
        guard
            url.scheme == "http",
            url.host == "127.0.0.1",
            let port = url.port,
            (1...65_535).contains(port),
            url.path.isEmpty,
            url.query == nil,
            url.fragment == nil,
            url.user == nil,
            url.password == nil
        else { return false }
        return url.absoluteString == "http://127.0.0.1:\(port)"
    }
}

@MainActor
protocol VoiceVACDesktopConnectionProviding: AnyObject {
    func verifiedConnection() async throws -> VoiceVACDesktopConnection
    func invalidate()
}

@MainActor
final class LiveVoiceVACDesktopConnectionProvider: VoiceVACDesktopConnectionProviding {
    typealias ConnectionLoader = @MainActor () throws -> Data
    typealias ChallengeGenerator = @MainActor () -> String

    private let transport: any VoiceVACBridgeTransport
    private let loadConnection: ConnectionLoader
    private let challengeGenerator: ChallengeGenerator
    private var cachedConnection: VoiceVACDesktopConnection?

    init(
        transport: any VoiceVACBridgeTransport,
        loadConnection: @escaping ConnectionLoader = VoiceVACDesktopConnectionFile.load,
        challengeGenerator: @escaping ChallengeGenerator = LiveVoiceVACDesktopConnectionProvider.makeChallenge
    ) {
        self.transport = transport
        self.loadConnection = loadConnection
        self.challengeGenerator = challengeGenerator
    }

    func verifiedConnection() async throws -> VoiceVACDesktopConnection {
        if let cachedConnection { return cachedConnection }
        let connection = try VoiceVACDesktopConnection(data: loadConnection())
        let challenge = challengeGenerator()
        guard challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw VoiceVACDesktopBridgeError.invalidConnection
        }
        let proofURL = try endpoint(
            connection.baseURL,
            path: "/v1/mcp/proof",
            queryItems: [URLQueryItem(name: "challenge", value: challenge)]
        )
        var request = URLRequest(url: proofURL)
        request.httpMethod = "GET"
        request.timeoutInterval = 1
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let response = try await transport.send(request)
        guard response.statusCode == 200, response.data.count <= 4_096 else {
            throw VoiceVACDesktopBridgeError.connectionUnavailable
        }
        try verifyProof(
            response.data,
            connection: connection,
            challenge: challenge
        )
        cachedConnection = connection
        return connection
    }

    func invalidate() {
        cachedConnection = nil
    }

    private func verifyProof(
        _ data: Data,
        connection: VoiceVACDesktopConnection,
        challenge: String
    ) throws {
        guard
            let value = try? JSONSerialization.jsonObject(with: data),
            let object = value as? [String: Any],
            Set(object.keys) == Set(["baseUrl", "proof", "protocolVersion", "service", "status"]),
            object["baseUrl"] as? String == connection.baseURL.absoluteString,
            object["protocolVersion"] as? Int == 1,
            object["service"] as? String == "voivox",
            object["status"] as? String == "ready",
            let proofText = object["proof"] as? String,
            let proof = Self.decodeSignature(proofText)
        else {
            throw VoiceVACDesktopBridgeError.invalidProof
        }
        let message = Data(
            "voivox-mcp-proof\n1\n\(challenge)\n\(connection.baseURL.absoluteString)".utf8
        )
        let expected = Data(HMAC<SHA256>.authenticationCode(
            for: message,
            using: SymmetricKey(data: Data(connection.token.utf8))
        ))
        guard Self.constantTimeEqual(expected, proof) else {
            throw VoiceVACDesktopBridgeError.invalidProof
        }
    }

    static func makeChallenge() -> String {
        var generator = SystemRandomNumberGenerator()
        let data = Data((0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeSignature(_ value: String) -> Data? {
        guard value.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            return nil
        }
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        base64.append(String(repeating: "=", count: (4 - base64.count % 4) % 4))
        guard let data = Data(base64Encoded: base64), data.count == 32 else { return nil }
        return data
    }

    private static func constantTimeEqual(_ first: Data, _ second: Data) -> Bool {
        guard first.count == second.count else { return false }
        var difference: UInt8 = 0
        for (left, right) in zip(first, second) { difference |= left ^ right }
        return difference == 0
    }
}

enum VoiceVACDesktopConnectionFile {
    static func candidates(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) -> [URL] {
        if let override = environment["VOICE_VAC_MCP_CONNECTION_FILE"], !override.isEmpty {
            return [URL(fileURLWithPath: override)]
        }
        let support = homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
        return ["Voice Vac", "Voice VAC"].map {
            support.appendingPathComponent($0, isDirectory: true)
                .appendingPathComponent("mcp-connection.json", isDirectory: false)
        }
    }

    static func load() throws -> Data {
        for path in candidates() where FileManager.default.fileExists(atPath: path.path) {
            let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
            guard let size = attributes[.size] as? NSNumber, size.intValue <= 65_536 else {
                throw VoiceVACDesktopBridgeError.invalidConnection
            }
            return try Data(contentsOf: path, options: [.mappedIfSafe])
        }
        throw VoiceVACDesktopBridgeError.connectionUnavailable
    }
}

enum VoiceVACDesktopBridgeError: Error, Equatable {
    case connectionUnavailable
    case invalidConnection
    case invalidProof
    case invalidResponse
    case commandRejected
}

@MainActor
final class VoiceVACDesktopBridge: CrossWindowSessionTokenProviding {
    private let store: VoiceVACStore
    private let connections: any VoiceVACDesktopConnectionProviding
    private let transport: any VoiceVACBridgeTransport
    private var pollTask: Task<Void, Never>?
    private var cachedDropToken: String?
    private var activeTunnel: TunnelSession?

    init(
        store: VoiceVACStore,
        connections: any VoiceVACDesktopConnectionProviding,
        transport: any VoiceVACBridgeTransport
    ) {
        self.store = store
        self.connections = connections
        self.transport = transport
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .milliseconds(300))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }

    func currentArmedDropToken() -> String? { cachedDropToken }

    func refresh() async {
        do {
            let connection = try await connections.verifiedConnection()
            let tunnels: TunnelList = try await get(
                connection,
                path: "/v1/tunnel-sessions",
                as: TunnelList.self
            )
            let newest = tunnels.sessions.max { left, right in left.updatedAt < right.updatedAt }
            activeTunnel = newest
            cachedDropToken = newest?.dropToken
            if let newest { synchronize(tunnel: newest) }
            if store.state.phase == .transcribing
                || store.state.phase == .paused
                || store.state.phase == .completed
            {
                let captures: CaptureList = try await get(
                    connection,
                    path: "/v1/sessions",
                    as: CaptureList.self
                )
                synchronize(captures: captures.sessions, tunnel: newest)
            }
        } catch {
            cachedDropToken = nil
            activeTunnel = nil
            connections.invalidate()
        }
    }

    func handle(_ effect: VoiceVACEffect) async {
        do {
            try await perform(effect)
        } catch {
            store.reportLocalFailure(VoiceVACFailure(
                code: .nativeHostUnavailable,
                message: "Voice VAC local bridge is unavailable"
            ))
        }
    }

    func perform(_ effect: VoiceVACEffect) async throws {
        let type: String
        switch effect {
        case .startCapture:
            type = "capture-start"
        case .pauseCapture:
            type = "capture-pause"
        case .resumeCapture:
            type = "capture-resume"
        case .stopAndFlush:
            type = "capture-stop"
        case .beginRetraction:
            return
        }
        guard
            let token = cachedDropToken,
            let session = try? NozzlePasteboard.parse(token)
        else {
            throw VoiceVACDesktopBridgeError.connectionUnavailable
        }
        let connection = try await connections.verifiedConnection()
        let body: [String: Any] = [
            "protocolVersion": 2,
            "commandId": UUID().uuidString.lowercased(),
            "sessionId": session.sessionID.uuidString.lowercased(),
            "type": type,
            "issuedAt": Date().timeIntervalSince1970 * 1_000
        ]
        let url = try endpoint(connection.baseURL, path: "/v1/extension-commands")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let response = try await transport.send(request)
        guard response.statusCode == 201 else {
            throw VoiceVACDesktopBridgeError.commandRejected
        }
    }

    private func synchronize(tunnel: TunnelSession) {
        guard
            let dragToken = try? NozzlePasteboard.parse(tunnel.dropToken),
            store.state.attemptID == dragToken.sessionID
        else { return }
        if tunnel.state == "ready", let rect = tunnel.targetRect {
            let frame = CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
            let target = VideoTarget(
                id: tunnel.id,
                kind: frame.isEmpty ? .tabAudio : .htmlMedia,
                tag: frame.isEmpty ? nil : .video,
                frameID: tunnel.frameId,
                documentID: tunnel.documentId,
                viewportRect: frame,
                screenRect: frame,
                activationPoint: CGPoint(x: frame.midX, y: frame.midY),
                canDirectPlay: !frame.isEmpty
            )
            if store.state.phase == .dragging {
                store.send(.targetDetected(target, attemptID: dragToken.sessionID))
            }
            if store.state.phase == .targetDetected || store.state.phase == .tabAudioOnly {
                store.send(.targetResolved(target, attemptID: dragToken.sessionID))
            }
        } else if tunnel.state == "completed" {
            store.send(.captureCompleted)
        } else if tunnel.state == "error" {
            store.reportLocalFailure(VoiceVACFailure(
                code: mapErrorCode(tunnel.errorCode),
                message: "Voice VAC could not use this video"
            ))
        }
    }

    private func synchronize(captures: [CaptureSession], tunnel: TunnelSession?) {
        let matching = captures.first { capture in
            guard capture.source.kind == "chrome-tab" else { return false }
            guard let url = tunnel?.url else { return true }
            return capture.source.url == url
        }
        guard let matching else { return }
        let preview = matching.rawSegments.map(\.text).joined(separator: " ")
        if !preview.isEmpty { store.send(.transcriptPreviewChanged(preview)) }
        if matching.status == "complete" { store.send(.captureCompleted) }
    }

    private func get<Value: Decodable>(
        _ connection: VoiceVACDesktopConnection,
        path: String,
        as type: Value.Type
    ) async throws -> Value {
        let url = try endpoint(connection.baseURL, path: path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 3
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let response = try await transport.send(request)
        guard response.statusCode == 200, response.data.count <= 1_500_000 else {
            throw VoiceVACDesktopBridgeError.invalidResponse
        }
        do {
            return try JSONDecoder().decode(type, from: response.data)
        } catch {
            throw VoiceVACDesktopBridgeError.invalidResponse
        }
    }
}

private struct TunnelList: Decodable {
    let sessions: [TunnelSession]
}

private struct TunnelSession: Decodable {
    let id: String
    let frameId: Int
    let documentId: String
    let dropToken: String
    let state: String
    let errorCode: String?
    let targetRect: TunnelRect?
    let url: String?
    let updatedAt: Double
}

private struct TunnelRect: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

private struct CaptureList: Decodable {
    let sessions: [CaptureSession]
}

private struct CaptureSession: Decodable {
    struct Source: Decodable {
        let kind: String
        let url: String?
    }

    struct Segment: Decodable {
        let text: String
    }

    let source: Source
    let status: String
    let rawSegments: [Segment]
}

private func endpoint(
    _ baseURL: URL,
    path: String,
    queryItems: [URLQueryItem] = []
) throws -> URL {
    guard VoiceVACDesktopConnection.isExactLoopback(baseURL),
          var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
    else { throw VoiceVACDesktopBridgeError.invalidConnection }
    components.path = path
    components.queryItems = queryItems.isEmpty ? nil : queryItems
    guard let url = components.url else { throw VoiceVACDesktopBridgeError.invalidConnection }
    return url
}

private func mapErrorCode(_ value: String?) -> VoiceVACErrorCode {
    switch value {
    case "TAB_CLOSED": .tabClosed
    case "TARGET_NAVIGATED": .targetNavigated
    case "CAPTURE_DENIED": .captureDenied
    case "STREAM_ID_EXPIRED": .streamIDExpired
    case "STREAM_ENDED": .streamEnded
    case "NO_AUDIO_AFTER_TIMEOUT": .noAudioAfterTimeout
    case "NO_PLAYABLE_MEDIA": .noPlayableMedia
    default: .nativeHostUnavailable
    }
}
