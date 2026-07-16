import CryptoKit
import Foundation

enum NativeServerProof {
    static let protocolVersion = 1
    static let requestTimeout: TimeInterval = 0.75

    static func verify(
        _ connection: NativeConnection,
        generateChallenge: () -> String = NativeServerProof.makeChallenge,
        fetchProof: (URL, TimeInterval) throws -> Data = NativeServerProof.fetch
    ) -> Bool {
        let challenge = generateChallenge()
        guard isValidChallenge(challenge) else { return false }

        guard var components = URLComponents(string: connection.baseUrl) else { return false }
        components.path = "/v1/native/proof"
        components.queryItems = [URLQueryItem(name: "challenge", value: challenge)]
        guard let url = components.url else { return false }

        let responseData: Data
        do {
            responseData = try fetchProof(url, requestTimeout)
        } catch {
            return false
        }
        guard responseData.count <= 4_096 else { return false }

        guard
            let object = try? JSONSerialization.jsonObject(with: responseData),
            let dictionary = object as? [String: Any],
            Set(dictionary.keys) == Set([
                "baseUrl", "proof", "protocolVersion", "service", "status"
            ]),
            dictionary["protocolVersion"] as? Int == protocolVersion,
            dictionary["service"] as? String == "voivox",
            dictionary["status"] as? String == "ready",
            dictionary["baseUrl"] as? String == connection.baseUrl,
            let encodedProof = dictionary["proof"] as? String,
            let receivedProof = decodeBase64URLSignature(encodedProof)
        else {
            return false
        }

        let message = Data(
            "voivox-native-proof\n\(protocolVersion)\n\(challenge)\n\(connection.baseUrl)".utf8
        )
        let expectedProof = Data(
            HMAC<SHA256>.authenticationCode(
                for: message,
                using: SymmetricKey(data: Data(connection.token.utf8))
            )
        )
        return constantTimeEqual(expectedProof, receivedProof)
    }

    static func makeChallenge() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in
            UInt8.random(in: UInt8.min...UInt8.max, using: &generator)
        }
        return encodeBase64URL(Data(bytes))
    }

    static func fetch(_ url: URL, timeout: TimeInterval) throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        configuration.timeoutIntervalForResource = timeout
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false

        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "accept")

        let completion = DispatchSemaphore(value: 0)
        let result = NativeProofFetchResult()
        let task = session.dataTask(with: request) { data, response, error in
            result.finish(data: data, response: response, error: error)
            completion.signal()
        }
        task.resume()

        guard completion.wait(timeout: .now() + timeout + 0.1) == .success else {
            task.cancel()
            session.invalidateAndCancel()
            throw NativeProofFetchError.unavailable
        }
        session.finishTasksAndInvalidate()
        guard let data = result.successfulData(maximumSize: 4_096) else {
            throw NativeProofFetchError.unavailable
        }
        return data
    }

    private static func isValidChallenge(_ challenge: String) -> Bool {
        challenge.utf8.count == 43 && challenge.utf8.allSatisfy { character in
            (character >= 65 && character <= 90)
                || (character >= 97 && character <= 122)
                || (character >= 48 && character <= 57)
                || character == 45
                || character == 95
        }
    }

    private static func encodeBase64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func decodeBase64URLSignature(_ value: String) -> Data? {
        guard isValidChallenge(value) else { return nil }
        var base64 = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while base64.utf8.count % 4 != 0 {
            base64.append("=")
        }
        guard let decoded = Data(base64Encoded: base64), decoded.count == 32 else {
            return nil
        }
        return decoded
    }

    private static func constantTimeEqual(_ first: Data, _ second: Data) -> Bool {
        guard first.count == second.count else { return false }
        var difference: UInt8 = 0
        for (left, right) in zip(first, second) {
            difference |= left ^ right
        }
        return difference == 0
    }
}

private enum NativeProofFetchError: Error {
    case unavailable
}

private final class NativeProofFetchResult: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var failed = true
    private var statusCode: Int?

    func finish(data: Data?, response: URLResponse?, error: Error?) {
        lock.lock()
        defer { lock.unlock() }
        self.data = data
        statusCode = (response as? HTTPURLResponse)?.statusCode
        failed = error != nil
    }

    func successfulData(maximumSize: Int) -> Data? {
        lock.lock()
        defer { lock.unlock() }
        guard !failed, statusCode == 200, let data, data.count <= maximumSize else {
            return nil
        }
        return data
    }
}
