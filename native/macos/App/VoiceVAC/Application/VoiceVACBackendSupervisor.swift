import Foundation

@MainActor
protocol VoiceVACBackendProcess: AnyObject {
    var executableURL: URL? { get set }
    var arguments: [String]? { get set }
    var environment: [String: String]? { get set }
    var isRunning: Bool { get }
    func run() throws
    func terminate()
}

@MainActor
private final class SystemVoiceVACBackendProcess: VoiceVACBackendProcess {
    private let process = Process()

    var executableURL: URL? {
        get { process.executableURL }
        set { process.executableURL = newValue }
    }

    var arguments: [String]? {
        get { process.arguments }
        set { process.arguments = newValue }
    }

    var environment: [String: String]? {
        get { process.environment }
        set { process.environment = newValue }
    }

    var isRunning: Bool { process.isRunning }

    func run() throws { try process.run() }
    func terminate() { process.terminate() }
}

@MainActor
final class VoiceVACBackendSupervisor {
    typealias ProcessFactory = @MainActor () -> any VoiceVACBackendProcess

    private let bundle: Bundle
    private let currentDirectory: URL
    private let environment: [String: String]
    private let fileManager: FileManager
    private let homeDirectory: URL
    private let processFactory: ProcessFactory
    private(set) var lastError: VoiceVACBackendSupervisorError?
    private(set) var process: (any VoiceVACBackendProcess)?

    init(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        bundle: Bundle = .main,
        currentDirectory: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        fileManager: FileManager = .default,
        processFactory: @escaping ProcessFactory = { SystemVoiceVACBackendProcess() }
    ) {
        self.bundle = bundle
        self.currentDirectory = currentDirectory
        self.environment = environment
        self.fileManager = fileManager
        self.homeDirectory = homeDirectory
        self.processFactory = processFactory
    }

    func start() {
        guard process == nil else { return }
        do {
            let launch = try resolveLaunch()
            let child = processFactory()
            child.executableURL = launch.executable
            child.arguments = launch.arguments
            child.environment = launch.environment
            try child.run()
            process = child
            lastError = nil
        } catch let error as VoiceVACBackendSupervisorError {
            lastError = error
        } catch {
            lastError = .launchFailed(error.localizedDescription)
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    func resolveLaunch() throws -> VoiceVACBackendLaunch {
        let script = try resolveBackendScript()
        let resourceDirectory = resolveResourceDirectory(script: script)
        let node = resolveNode()
        var childEnvironment = environment
        childEnvironment["VOICE_VAC_RESOURCE_DIR"] = resourceDirectory.path
        childEnvironment["VOICE_VAC_BACKEND_SUPERVISED"] = "1"

        if node.lastPathComponent == "env" {
            return VoiceVACBackendLaunch(
                arguments: ["node", script.path],
                environment: childEnvironment,
                executable: node
            )
        }
        return VoiceVACBackendLaunch(
            arguments: [script.path],
            environment: childEnvironment,
            executable: node
        )
    }

    private func resolveBackendScript() throws -> URL {
        var candidates: [URL] = []
        if let override = environment["VOICE_VAC_BACKEND_SCRIPT"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }
        if let bundled = bundle.url(forResource: "voice-vac-backend", withExtension: "mjs") {
            candidates.append(bundled)
        }
        candidates.append(currentDirectory.appendingPathComponent("apps/desktop/dist/headless/voice-vac-backend.mjs"))
        candidates.append(currentDirectory.appendingPathComponent("dist/headless/voice-vac-backend.mjs"))
        if let found = candidates.first(where: { fileManager.isReadableFile(atPath: $0.path) }) {
            return found
        }
        throw VoiceVACBackendSupervisorError.backendScriptMissing
    }

    private func resolveResourceDirectory(script: URL) -> URL {
        if let override = environment["VOICE_VAC_RESOURCE_DIR"], !override.isEmpty {
            return URL(fileURLWithPath: override)
        }
        // Xcode copies the headless script and Python worker into the same
        // Contents/Resources directory. Keep the runtime lookup valid for a
        // signed app bundle as well as the workspace dist layout.
        if script.deletingLastPathComponent().lastPathComponent == "Resources" {
            return script.deletingLastPathComponent()
        }
        let sibling = script.deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("resources", isDirectory: true)
        if fileManager.fileExists(atPath: sibling.path) { return sibling }
        return homeDirectory.appendingPathComponent("Library/Application Support/Voice Vac/resources", isDirectory: true)
    }

    private func resolveNode() -> URL {
        var candidates: [URL] = []
        if let override = environment["VOICE_VAC_NODE_PATH"], !override.isEmpty {
            candidates.append(URL(fileURLWithPath: override))
        }
        if let bundled = bundle.url(forResource: "node", withExtension: nil) {
            candidates.append(bundled)
        }
        candidates += [
            currentDirectory.appendingPathComponent(".node/bin/node"),
            URL(fileURLWithPath: "/opt/homebrew/bin/node"),
            URL(fileURLWithPath: "/usr/local/bin/node"),
            URL(fileURLWithPath: "/usr/bin/node")
        ]
        if let found = candidates.first(where: { fileManager.isExecutableFile(atPath: $0.path) }) {
            return found
        }
        return URL(fileURLWithPath: "/usr/bin/env")
    }
}

struct VoiceVACBackendLaunch: Equatable {
    let arguments: [String]
    let environment: [String: String]
    let executable: URL
}

enum VoiceVACBackendSupervisorError: Error, Equatable {
    case backendScriptMissing
    case launchFailed(String)
}
