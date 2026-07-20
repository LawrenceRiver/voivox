import CryptoKit
import Foundation
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class DesktopBridgeTests: XCTestCase {
    private let sessionID = UUID(uuidString: "2B0FE529-4021-4674-B55E-1CF081F947DD")!
    private let dropToken = "VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    private let connection = VoiceVACDesktopConnection(
        baseURL: URL(string: "http://127.0.0.1:43817")!,
        token: "primary-desktop-token"
    )

    func testConnectionFileAcceptsOnlyExactLoopbackAuthorityAndFields() throws {
        let valid = try VoiceVACDesktopConnection(data: Data(
            #"{"baseUrl":"http://127.0.0.1:43817","token":"secret"}"#.utf8
        ))
        XCTAssertEqual(valid.baseURL.absoluteString, "http://127.0.0.1:43817")
        XCTAssertEqual(valid.token, "secret")

        for json in [
            #"{"baseUrl":"http://localhost:43817","token":"secret"}"#,
            #"{"baseUrl":"https://127.0.0.1:43817","token":"secret"}"#,
            #"{"baseUrl":"http://127.0.0.1:43817/path","token":"secret"}"#,
            #"{"baseUrl":"http://127.0.0.1:43817","token":"secret","extra":true}"#
        ] {
            XCTAssertThrowsError(try VoiceVACDesktopConnection(data: Data(json.utf8)))
        }
    }

    func testPrimaryConnectionIsProofVerifiedBeforeItsTokenIsUsed() async throws {
        let challenge = String(repeating: "A", count: 43)
        let token = connection.token
        let transport = BridgeTransportStub { request in
            XCTAssertEqual(request.url?.path, "/v1/mcp/proof")
            XCTAssertNil(request.value(forHTTPHeaderField: "authorization"))
            XCTAssertFalse(request.url!.absoluteString.contains(token))
            let message = Data(
                "voivox-mcp-proof\n1\n\(challenge)\nhttp://127.0.0.1:43817".utf8
            )
            let proof = Data(HMAC<SHA256>.authenticationCode(
                for: message,
                using: SymmetricKey(data: Data(token.utf8))
            )).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
            let data = try JSONSerialization.data(withJSONObject: [
                "baseUrl": "http://127.0.0.1:43817",
                "proof": proof,
                "protocolVersion": 1,
                "service": "voivox",
                "status": "ready"
            ])
            return VoiceVACHTTPResponse(data: data, statusCode: 200)
        }
        let provider = LiveVoiceVACDesktopConnectionProvider(
            transport: transport,
            loadConnection: {
                Data(#"{"baseUrl":"http://127.0.0.1:43817","token":"primary-desktop-token"}"#.utf8)
            },
            challengeGenerator: { challenge }
        )

        let verified = try await provider.verifiedConnection()
        XCTAssertEqual(verified, connection)
        _ = try await provider.verifiedConnection()
        XCTAssertEqual(transport.requests.count, 1)
    }

    func testRefreshCachesNewestArmedTokenAndResolvesTheDraggedVideo() async {
        let store = VoiceVACStore()
        store.send(.beginNozzleDrag(at: .zero, attemptID: sessionID))
        let transport = BridgeTransportStub { [dropToken] request in
            XCTAssertEqual(request.url?.path, "/v1/tunnel-sessions")
            return VoiceVACHTTPResponse(
                data: Data(#"{"sessions":[{"id":"voice-vac-session","frameId":0,"documentId":"document-1","dropToken":"\#(dropToken)","state":"ready","targetRect":{"x":40,"y":60,"width":640,"height":360},"url":"https://example.com/video","updatedAt":2000}]}"#.utf8),
                statusCode: 200
            )
        }
        let bridge = VoiceVACDesktopBridge(
            store: store,
            connections: StaticConnectionProvider(connection),
            transport: transport
        )

        await bridge.refresh()

        XCTAssertEqual(bridge.currentArmedDropToken(), dropToken)
        XCTAssertEqual(store.state.phase, .ready)
        XCTAssertEqual(store.state.target?.documentID, "document-1")
        XCTAssertEqual(store.state.target?.screenRect, CGRect(x: 40, y: 60, width: 640, height: 360))
    }

    func testPhysicalButtonPublishesOneProtocolTwoCommandWithoutPuttingTokenInBody() async throws {
        let store = VoiceVACStore()
        store.send(.beginNozzleDrag(at: .zero, attemptID: sessionID))
        let transport = BridgeTransportStub { [dropToken] request in
            if request.url?.path == "/v1/tunnel-sessions" {
                return VoiceVACHTTPResponse(
                    data: Data(#"{"sessions":[{"id":"voice-vac-session","frameId":0,"documentId":"document-1","dropToken":"\#(dropToken)","state":"ready","targetRect":{"x":40,"y":60,"width":640,"height":360},"url":"https://example.com/video","updatedAt":2000}]}"#.utf8),
                    statusCode: 200
                )
            }
            return VoiceVACHTTPResponse(data: request.httpBody ?? Data(), statusCode: 201)
        }
        let bridge = VoiceVACDesktopBridge(
            store: store,
            connections: StaticConnectionProvider(connection),
            transport: transport
        )
        await bridge.refresh()

        let target = try XCTUnwrap(store.state.target)
        try await bridge.perform(.startCapture(target))

        let request = try XCTUnwrap(transport.requests.last)
        XCTAssertEqual(request.url?.path, "/v1/extension-commands")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer primary-desktop-token")
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(body["protocolVersion"] as? Int, 2)
        XCTAssertEqual(body["sessionId"] as? String, sessionID.uuidString.lowercased())
        XCTAssertEqual(body["type"] as? String, "capture-start")
        XCTAssertNil(body["token"])
        XCTAssertFalse(String(decoding: request.httpBody ?? Data(), as: UTF8.self).contains(connection.token))
    }

    func testRefreshStreamsOnlyMatchingChromeTranscriptIntoTheBubble() async {
        let target = VideoTarget(
            id: "video-1",
            kind: .htmlMedia,
            tag: .video,
            frameID: 0,
            documentID: "document-1",
            viewportRect: CGRect(x: 0, y: 0, width: 640, height: 360),
            screenRect: CGRect(x: 40, y: 60, width: 640, height: 360),
            activationPoint: CGPoint(x: 320, y: 180),
            canDirectPlay: true
        )
        let store = VoiceVACStore(state: VoiceVACState(
            phase: .transcribing,
            target: target,
            attemptID: sessionID
        ))
        let transport = BridgeTransportStub { [dropToken] request in
            if request.url?.path == "/v1/tunnel-sessions" {
                return VoiceVACHTTPResponse(
                    data: Data(#"{"sessions":[{"id":"voice-vac-session","frameId":0,"documentId":"document-1","dropToken":"\#(dropToken)","state":"completed","url":"https://example.com/video","updatedAt":2000}]}"#.utf8),
                    statusCode: 200
                )
            }
            return VoiceVACHTTPResponse(
                data: Data(#"{"sessions":[{"source":{"kind":"chrome-tab","url":"https://example.com/video"},"status":"complete","rawSegments":[{"text":"Private audio"},{"text":"became text."}]}]}"#.utf8),
                statusCode: 200
            )
        }
        let bridge = VoiceVACDesktopBridge(
            store: store,
            connections: StaticConnectionProvider(connection),
            transport: transport
        )

        await bridge.refresh()

        XCTAssertEqual(store.state.transcriptPreview, "Private audio became text.")
        XCTAssertEqual(store.state.phase, .completed)
    }
}

@MainActor
private final class StaticConnectionProvider: VoiceVACDesktopConnectionProviding {
    private let connection: VoiceVACDesktopConnection
    init(_ connection: VoiceVACDesktopConnection) { self.connection = connection }
    func verifiedConnection() async throws -> VoiceVACDesktopConnection { connection }
    func invalidate() {}
}

@MainActor
private final class BridgeTransportStub: VoiceVACBridgeTransport {
    typealias Handler = @MainActor (URLRequest) throws -> VoiceVACHTTPResponse
    private let handler: Handler
    private(set) var requests: [URLRequest] = []

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    func send(_ request: URLRequest) async throws -> VoiceVACHTTPResponse {
        requests.append(request)
        return try handler(request)
    }
}
