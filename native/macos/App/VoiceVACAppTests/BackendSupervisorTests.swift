import Foundation
import XCTest
@testable import Voice_VAC

@MainActor
final class BackendSupervisorTests: XCTestCase {
    func testResolvesWorkspaceHeadlessBackendAndInjectsResourceDirectory() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("voice-vac-supervisor-(UUID().uuidString)", isDirectory: true)
        let script = root.appendingPathComponent("apps/desktop/dist/headless/voice-vac-backend.mjs")
        let resources = root.appendingPathComponent("apps/desktop/dist/resources", isDirectory: true)
        try FileManager.default.createDirectory(at: script.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: resources, withIntermediateDirectories: true)
        try Data("#!/usr/bin/env node\n".utf8).write(to: script)
        let bundle = try makeEmptyBundle(in: root)

        let supervisor = VoiceVACBackendSupervisor(
            environment: ["PATH": "/usr/bin"],
            bundle: bundle,
            currentDirectory: root
        )
        let launch = try supervisor.resolveLaunch()

        XCTAssertEqual(launch.arguments, ["node", script.path])
        XCTAssertEqual(launch.environment["VOICE_VAC_RESOURCE_DIR"], resources.path)
        XCTAssertEqual(launch.environment["VOICE_VAC_BACKEND_SUPERVISED"], "1")
        XCTAssertFalse(launch.executable.path.isEmpty)

        try? FileManager.default.removeItem(at: root)
    }

    func testStartIsIdempotentAndStopTerminatesTheChild() {
        let process = StubBackendProcess()
        let bundle = try! makeEmptyBundle(in: FileManager.default.temporaryDirectory)
        let supervisor = VoiceVACBackendSupervisor(
            environment: ["VOICE_VAC_BACKEND_SCRIPT": "/tmp/backend.mjs", "VOICE_VAC_NODE_PATH": "/tmp/node"],
            bundle: bundle,
            fileManager: StubFileManager(paths: ["/tmp/backend.mjs", "/tmp/node"]),
            processFactory: { process }
        )

        supervisor.start()
        supervisor.start()
        XCTAssertEqual(process.runCount, 1)
        XCTAssertNotNil(supervisor.process)

        supervisor.stop()
        XCTAssertEqual(process.terminateCount, 1)
        XCTAssertNil(supervisor.process)
    }

    func testMissingBackendDoesNotPretendTheAppIsConnected() {
        let bundle = try! makeEmptyBundle(in: FileManager.default.temporaryDirectory)
        let supervisor = VoiceVACBackendSupervisor(
            environment: [:],
            bundle: bundle,
            currentDirectory: URL(fileURLWithPath: "/tmp/voice-vac-no-project")
        )

        supervisor.start()

        XCTAssertEqual(supervisor.lastError, .backendScriptMissing)
        XCTAssertNil(supervisor.process)
    }

    private func makeEmptyBundle(in parent: URL) throws -> Bundle {
        let url = parent.appendingPathComponent("VoiceVACTest-\(UUID().uuidString).bundle", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleIdentifier": "io.voivox.tests.\(UUID().uuidString)",
            "CFBundlePackageType": "BNDL"
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .binary, options: 0)
        try data.write(to: url.appendingPathComponent("Info.plist"))
        return try XCTUnwrap(Bundle(url: url))
    }
}

@MainActor
private final class StubBackendProcess: VoiceVACBackendProcess {
    var executableURL: URL?
    var arguments: [String]?
    var environment: [String: String]?
    var isRunning = false
    var runCount = 0
    var terminateCount = 0
    func run() throws { runCount += 1; isRunning = true }
    func terminate() { terminateCount += 1; isRunning = false }
}

@MainActor
private final class StubFileManager: FileManager {
    private let paths: Set<String>
    init(paths: Set<String>) { self.paths = paths; super.init() }
    override func isReadableFile(atPath path: String) -> Bool { paths.contains(path) }
    override func isExecutableFile(atPath path: String) -> Bool { paths.contains(path) }
    override func fileExists(atPath path: String) -> Bool { paths.contains(path) }
}
