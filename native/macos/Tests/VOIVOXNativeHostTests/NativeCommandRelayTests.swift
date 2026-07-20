import Foundation
import Testing
@testable import VOIVOXNativeHost

@Suite("Voice VAC native command relay")
struct NativeCommandRelayTests {
    private let connection = NativeConnection(
        baseUrl: "http://127.0.0.1:43817",
        token: "restricted-extension-token",
        localAsr: .ready
    )

    @Test("accepts only the exact protocol-two connect request")
    func acceptsConnect() throws {
        #expect(
            try NativeHostRequest.parse(
                Data(#"{"protocolVersion":2,"type":"connect"}"#.utf8)
            ) == .connect
        )
        #expect(
            try NativeHostRequest.parse(
                Data(#"{"protocolVersion":1,"type":"discover"}"#.utf8)
            ) == .discover
        )
        #expect(throws: NativeHostError.unsupportedRequest) {
            try NativeHostRequest.parse(
                Data(#"{"protocolVersion":2,"type":"connect","token":"steal"}"#.utf8)
            )
        }
    }

    @Test("relays an authenticated command batch without tokens")
    func relaysBatch() throws {
        var receivedRequest: URLRequest?
        var receivedTimeout: TimeInterval?
        let relay = NativeCommandRelay(fetch: { request, timeout in
            receivedRequest = request
            receivedTimeout = timeout
            return Data(#"{"cursor":1,"commands":[{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000}]}"#.utf8)
        })

        let batch = try relay.pollOnce(connection: connection, after: 0, waitMilliseconds: 20_000)

        #expect(batch.cursor == 1)
        #expect(batch.commands.count == 1)
        let command = try #require(
            JSONSerialization.jsonObject(with: batch.commands[0]) as? [String: Any]
        )
        #expect(command["type"] as? String == "capture-start")
        #expect(command["commandId"] as? String == "11111111-1111-4111-8111-111111111111")
        #expect(command["token"] == nil)
        #expect(String(decoding: batch.commands[0], as: UTF8.self).contains(connection.token) == false)
        #expect(receivedRequest?.url?.absoluteString == "http://127.0.0.1:43817/v1/native/extension-commands?after=0&wait=20000")
        #expect(receivedRequest?.value(forHTTPHeaderField: "authorization") == "Bearer restricted-extension-token")
        #expect(receivedRequest?.httpMethod == "GET")
        #expect(try #require(receivedTimeout) <= 21)
    }

    @Test("rejects untrusted relay inputs", arguments: [
        #"{"cursor":-1,"commands":[]}"#,
        #"{"cursor":1,"commands":[],"token":"leak"}"#,
        #"{"cursor":1,"commands":[{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"unknown","issuedAt":1000}]}"#,
        #"{"cursor":1,"commands":[{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000,"token":"leak"}]}"#,
        #"{"cursor":1,"commands":[{"protocolVersion":2,"commandId":"wrong","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000}]}"#
    ])
    func rejectsUntrustedResponses(json: String) {
        let relay = NativeCommandRelay(fetch: { _, _ in Data(json.utf8) })
        #expect(throws: NativeCommandRelayError.invalidResponse) {
            try relay.pollOnce(connection: connection, after: 0, waitMilliseconds: 0)
        }
    }

    @Test("rejects non-loopback connections and invalid cursors")
    func rejectsInvalidRequestAuthority() {
        let relay = NativeCommandRelay(fetch: { _, _ in Data(#"{"cursor":0,"commands":[]}"#.utf8) })
        let remote = NativeConnection(
            baseUrl: "https://example.com",
            token: "restricted-extension-token",
            localAsr: .ready
        )
        #expect(throws: NativeCommandRelayError.invalidConnection) {
            try relay.pollOnce(connection: remote, after: 0, waitMilliseconds: 0)
        }
        #expect(throws: NativeCommandRelayError.invalidCursor) {
            try relay.pollOnce(connection: connection, after: -1, waitMilliseconds: 0)
        }
        #expect(throws: NativeCommandRelayError.invalidWait) {
            try relay.pollOnce(connection: connection, after: 0, waitMilliseconds: 20_001)
        }
    }

    @Test("switches a protocol-two native port into authenticated relay mode")
    func runsConnectedPort() throws {
        let request = Data(#"{"protocolVersion":2,"type":"connect"}"#.utf8)
        let input = Pipe()
        let output = Pipe()
        try input.fileHandleForWriting.write(contentsOf: NativeMessageFraming.frame(request))
        try input.fileHandleForWriting.close()
        let connectionData = Data(#"{"service":"voivox","status":"ready","baseUrl":"http://127.0.0.1:43817","token":"restricted-token","capabilities":{"localAsr":"ready"}}"#.utf8)
        var relayedConnection: NativeConnection?
        let command = Data(#"{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000}"#.utf8)

        NativeMessagingHost.run(
            input: input.fileHandleForReading,
            output: output.fileHandleForWriting,
            loadConnection: { connectionData },
            verifyConnection: { _ in true },
            relayCommands: { connection, output, _ in
                relayedConnection = connection
                try NativeMessageFraming.writeMessage(command, to: output)
            }
        )
        try output.fileHandleForWriting.close()
        let replies = try NativeMessageFraming.decodeAll(
            output.fileHandleForReading.readDataToEndOfFile()
        )

        #expect(relayedConnection?.token == "restricted-token")
        #expect(replies.count == 2)
        let handshake = try #require(
            JSONSerialization.jsonObject(with: replies[0]) as? [String: Any]
        )
        #expect(handshake["protocolVersion"] as? Int == 2)
        #expect(handshake["service"] as? String == "voivox")
        #expect(handshake["status"] as? String == "connected")
        #expect(handshake["token"] == nil)
        #expect(replies[1] == command)
        #expect(String(decoding: replies[0], as: UTF8.self).contains("restricted-token") == false)
    }

    @Test("rejects regressed and non-progressing command cursors")
    func rejectsCursorRegression() {
        let regressed = NativeCommandRelay(fetch: { _, _ in
            Data(#"{"cursor":4,"commands":[]}"#.utf8)
        })
        #expect(throws: NativeCommandRelayError.invalidResponse) {
            try regressed.pollOnce(connection: connection, after: 5, waitMilliseconds: 0)
        }

        let stalled = NativeCommandRelay(fetch: { _, _ in
            Data(#"{"cursor":5,"commands":[{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000}]}"#.utf8)
        })
        #expect(throws: NativeCommandRelayError.invalidResponse) {
            try stalled.pollOnce(connection: connection, after: 5, waitMilliseconds: 0)
        }
    }

    @Test("stops cooperatively and retries only transient network failures")
    func stopsAndRetriesSelectively() throws {
        var fetchCount = 0
        var stopped = false
        let transient = NativeCommandRelay(fetch: { _, _ in
            fetchCount += 1
            throw NativeCommandRelayError.unavailable
        })
        try transient.relay(
            connection: connection,
            output: Pipe().fileHandleForWriting,
            shouldStop: { stopped },
            sleep: { _ in stopped = true }
        )
        #expect(fetchCount == 1)

        var invalidFetchCount = 0
        let invalid = NativeCommandRelay(fetch: { _, _ in
            invalidFetchCount += 1
            return Data(#"{"cursor":0,"commands":[],"secret":"wrong"}"#.utf8)
        })
        #expect(throws: NativeCommandRelayError.invalidResponse) {
            try invalid.relay(
                connection: connection,
                output: Pipe().fileHandleForWriting,
                shouldStop: { false },
                sleep: { _ in Issue.record("invalid responses must not retry") }
            )
        }
        #expect(invalidFetchCount == 1)
    }

    @Test("observes native-port EOF once without a readability busy loop")
    func observesEOFOnce() throws {
        let pipe = Pipe()
        let lifetime = NativePortLifetime(input: pipe.fileHandleForReading)
        lifetime.start()
        try pipe.fileHandleForWriting.close()

        let deadline = Date().addingTimeInterval(0.25)
        while !lifetime.hasEnded, Date() < deadline {
            Thread.sleep(forTimeInterval: 0.005)
        }
        Thread.sleep(forTimeInterval: 0.02)
        lifetime.stop()

        #expect(lifetime.hasEnded)
        #expect(lifetime.notificationCount == 1)
    }
}
