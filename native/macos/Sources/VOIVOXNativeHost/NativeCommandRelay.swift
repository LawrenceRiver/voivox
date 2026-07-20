import CoreFoundation
import Foundation

enum NativeCommandRelayError: Error, Equatable {
    case invalidConnection
    case invalidCursor
    case invalidWait
    case invalidResponse
    case unavailable
}

struct NativeCommandBatch: Equatable {
    let cursor: Int
    let commands: [Data]
}

final class NativeCommandRelay {
    typealias Fetch = (URLRequest, TimeInterval) throws -> Data

    static let maximumWaitMilliseconds = 20_000
    static let maximumResponseBytes = 1_500_000
    private static let commandTypes: Set<String> = [
        "drag-begin", "drag-cancel", "capture-start", "capture-pause",
        "capture-resume", "capture-stop", "target-disconnect"
    ]
    private static let commandKeys: Set<String> = [
        "protocolVersion", "commandId", "sessionId", "type", "issuedAt"
    ]
    private static let responseKeys: Set<String> = ["cursor", "commands"]

    private let fetch: Fetch

    init(fetch: @escaping Fetch = NativeCommandRelay.fetchData) {
        self.fetch = fetch
    }

    func pollOnce(
        connection: NativeConnection,
        after: Int,
        waitMilliseconds: Int = maximumWaitMilliseconds
    ) throws -> NativeCommandBatch {
        guard NativeConnection.isExactLoopbackBaseUrl(connection.baseUrl) else {
            throw NativeCommandRelayError.invalidConnection
        }
        guard after >= 0 else { throw NativeCommandRelayError.invalidCursor }
        guard (0...Self.maximumWaitMilliseconds).contains(waitMilliseconds) else {
            throw NativeCommandRelayError.invalidWait
        }
        guard var components = URLComponents(string: connection.baseUrl) else {
            throw NativeCommandRelayError.invalidConnection
        }
        components.path = "/v1/native/extension-commands"
        components.queryItems = [
            URLQueryItem(name: "after", value: String(after)),
            URLQueryItem(name: "wait", value: String(waitMilliseconds))
        ]
        guard let url = components.url else { throw NativeCommandRelayError.invalidConnection }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "authorization")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let timeout = min(Double(waitMilliseconds) / 1_000 + 0.75, 20.75)
        request.timeoutInterval = timeout
        let data: Data
        do {
            data = try fetch(request, timeout)
        } catch let error as NativeCommandRelayError {
            throw error
        } catch {
            throw NativeCommandRelayError.unavailable
        }
        guard data.count <= Self.maximumResponseBytes else {
            throw NativeCommandRelayError.invalidResponse
        }
        return try Self.parseBatch(data, after: after)
    }

    func relay(
        connection: NativeConnection,
        output: FileHandle,
        shouldStop: () -> Bool,
        sleep: (TimeInterval) -> Void = Thread.sleep(forTimeInterval:)
    ) throws {
        var cursor = 0
        var retryDelay: TimeInterval = 0.25
        while !shouldStop() {
            let batch: NativeCommandBatch
            do {
                batch = try pollOnce(connection: connection, after: cursor)
                retryDelay = 0.25
            } catch NativeCommandRelayError.unavailable {
                sleepInterruptibly(retryDelay, shouldStop: shouldStop, sleep: sleep)
                retryDelay = min(retryDelay * 2, 5)
                continue
            } catch {
                throw error
            }
            if shouldStop() { return }
            for command in batch.commands {
                try NativeMessageFraming.writeMessage(command, to: output)
            }
            cursor = batch.cursor
        }
    }

    static func parseBatch(_ data: Data, after: Int) throws -> NativeCommandBatch {
        guard
            let value = try? JSONSerialization.jsonObject(with: data),
            let object = value as? [String: Any],
            Set(object.keys) == responseKeys,
            let cursor = object["cursor"] as? Int,
            cursor >= after,
            let rawCommands = object["commands"] as? [Any],
            rawCommands.count <= 256,
            rawCommands.isEmpty || cursor > after,
            rawCommands.count <= cursor - after
        else {
            throw NativeCommandRelayError.invalidResponse
        }

        let commands = try rawCommands.map { raw -> Data in
            guard
                let command = raw as? [String: Any],
                Set(command.keys) == commandKeys,
                command["protocolVersion"] as? Int == 2,
                let commandID = command["commandId"] as? String,
                isCanonicalUUID(commandID),
                let sessionID = command["sessionId"] as? String,
                isCanonicalUUID(sessionID),
                let type = command["type"] as? String,
                commandTypes.contains(type),
                isFiniteJSONNumber(command["issuedAt"])
            else {
                throw NativeCommandRelayError.invalidResponse
            }
            return try JSONSerialization.data(withJSONObject: [
                "protocolVersion": 2,
                "commandId": commandID,
                "sessionId": sessionID,
                "type": type,
                "issuedAt": command["issuedAt"] as Any
            ], options: [.sortedKeys])
        }
        return NativeCommandBatch(cursor: cursor, commands: commands)
    }

    private func sleepInterruptibly(
        _ duration: TimeInterval,
        shouldStop: () -> Bool,
        sleep: (TimeInterval) -> Void
    ) {
        var remaining = duration
        while remaining > 0, !shouldStop() {
            let interval = min(remaining, 0.05)
            sleep(interval)
            remaining -= interval
        }
    }

    static func fetchData(_ request: URLRequest, timeout: TimeInterval) throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false

        guard let expectedURL = request.url else { throw NativeCommandRelayError.invalidConnection }
        let delegate = NativeCommandFetchDelegate(
            expectedURL: expectedURL,
            maximumSize: maximumResponseBytes
        )
        let session = URLSession(
            configuration: configuration,
            delegate: delegate,
            delegateQueue: nil
        )
        let task = session.dataTask(with: request)
        task.resume()
        guard delegate.completion.wait(timeout: .now() + timeout + 0.1) == .success else {
            task.cancel()
            session.invalidateAndCancel()
            throw NativeCommandRelayError.unavailable
        }
        session.finishTasksAndInvalidate()
        return try delegate.result()
    }

    private static func isCanonicalUUID(_ value: String) -> Bool {
        value.range(
            of: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            options: [.regularExpression, .caseInsensitive]
        ) != nil && UUID(uuidString: value) != nil
    }

    private static func isFiniteJSONNumber(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber else { return false }
        guard CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.doubleValue.isFinite
    }
}

private final class NativeCommandFetchDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let completion = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private let expectedURL: URL
    private let maximumSize: Int
    private var data = Data()
    private var failure: NativeCommandRelayError?
    private var completed = false

    init(expectedURL: URL, maximumSize: Int) {
        self.expectedURL = expectedURL
        self.maximumSize = maximumSize
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        markFailed(.invalidResponse)
        completionHandler(nil)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard
            let response = response as? HTTPURLResponse,
            response.statusCode == 200,
            response.url == expectedURL
        else {
            markFailed(.invalidResponse)
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive incoming: Data
    ) {
        lock.lock()
        if failure != nil || data.count + incoming.count > maximumSize {
            failure = .invalidResponse
            lock.unlock()
            dataTask.cancel()
            return
        }
        data.append(incoming)
        lock.unlock()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        lock.lock()
        if error != nil, failure == nil { failure = .unavailable }
        let shouldSignal = !completed
        completed = true
        lock.unlock()
        if shouldSignal { completion.signal() }
    }

    func result() throws -> Data {
        lock.lock()
        defer { lock.unlock() }
        guard completed, data.count <= maximumSize else {
            throw NativeCommandRelayError.unavailable
        }
        if let failure { throw failure }
        return data
    }

    private func markFailed(_ error: NativeCommandRelayError) {
        lock.lock()
        failure = error
        lock.unlock()
    }
}
