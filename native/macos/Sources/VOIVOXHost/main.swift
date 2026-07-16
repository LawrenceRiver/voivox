import AVFoundation
import AppKit
import CoreAudio
import Foundation

@main
struct VOIVOXHost {
    static func main() {
        do {
            let command = Array(CommandLine.arguments.dropFirst())
            guard let action = command.first else {
                try printJSON(["error": "Use `list` or `record <pid> <output.wav> [--audible]`."])
                return
            }

            switch action {
            case "list":
                try printJSON(try runningApplications())
            case "record":
                guard command.count >= 3, let pid = Int32(command[1]) else {
                    throw HostError.invalidArguments
                }
                let outputPath = String(command[2])
                let mode: ProcessTapMode = command.contains("--audible") ? .audible : .silent
                try record(pid: pid, outputPath: outputPath, mode: mode)
            default:
                throw HostError.invalidArguments
            }
        } catch {
            FileHandle.standardError.write(Data("VOIVOX host error: \(error.localizedDescription)\n".utf8))
            exit(1)
        }
    }

    private static func runningApplications() throws -> [[String: Any]] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyProcessObjectList,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        let sizeStatus = AudioObjectGetPropertyDataSize(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size
        )
        guard sizeStatus == noErr else {
            throw HostError.coreAudio(operation: "AudioObjectGetPropertyDataSize(ProcessObjectList)", status: sizeStatus)
        }
        let count = Int(size) / MemoryLayout<AudioObjectID>.size
        guard count > 0 else { return [] }
        var processObjectIDs = [AudioObjectID](repeating: kAudioObjectUnknown, count: count)
        let listStatus = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &processObjectIDs
        )
        guard listStatus == noErr else {
            throw HostError.coreAudio(operation: "AudioObjectGetPropertyData(ProcessObjectList)", status: listStatus)
        }

        var result: [[String: Any]] = []
        for processObjectID in processObjectIDs {
            var pid = pid_t(0)
            var pidAddress = AudioObjectPropertyAddress(
                mSelector: kAudioProcessPropertyPID,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            var pidSize = UInt32(MemoryLayout<pid_t>.size)
            guard AudioObjectGetPropertyData(
                processObjectID,
                &pidAddress,
                0,
                nil,
                &pidSize,
                &pid
            ) == noErr, pid > 0 else { continue }

            let application = NSRunningApplication(processIdentifier: pid)
            let name = application?.localizedName ?? "Audio process \(pid)"
            let bundleID = application?.bundleIdentifier ?? ""
            result.append(["pid": pid, "name": name, "bundleId": bundleID])
        }
        return result.sorted { ($0["name"] as? String ?? "") < ($1["name"] as? String ?? "") }
    }

    private static func record(pid: Int32, outputPath: String, mode: ProcessTapMode) throws {
        guard #available(macOS 14.2, *) else { throw HostError.unsupportedSystem }
        let recorder = try ProcessTapFileRecorder(
            configuration: ProcessTapConfiguration(pid: pid, mode: mode),
            outputURL: URL(fileURLWithPath: outputPath)
        )
        try recorder.start()
        try printJSON([
            "event": "started",
            "pid": pid,
            "output": outputPath,
            "mode": mode.rawValue
        ])

        let stop = RecordingStopCoordinator(
            teardown: { recorder.stop() },
            completion: {
                try? printJSON(["event": "stopped", "output": outputPath])
                exit(0)
            }
        )
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        signal(SIGINT, SIG_IGN)
        interrupt.setEventHandler {
            stop.requestStop()
        }
        let parentPipe = StandardInputEOFMonitor(input: .standardInput, queue: .main) {
            stop.requestStop()
        }
        interrupt.resume()
        parentPipe.start()
        withExtendedLifetime((interrupt, parentPipe, stop)) {
            RunLoop.current.run()
        }
    }
}

final class RecordingStopCoordinator {
    private let completion: () -> Void
    private var didStop = false
    private let lock = NSLock()
    private let teardown: () -> Void

    init(teardown: @escaping () -> Void, completion: @escaping () -> Void) {
        self.teardown = teardown
        self.completion = completion
    }

    func requestStop() {
        lock.lock()
        guard !didStop else {
            lock.unlock()
            return
        }
        didStop = true
        lock.unlock()

        teardown()
        completion()
    }
}

final class StandardInputEOFMonitor {
    private var didFinish = false
    private let input: FileHandle
    private let lock = NSLock()
    private let onEOF: () -> Void
    private let queue: DispatchQueue
    private var source: DispatchSourceRead?

    init(input: FileHandle, queue: DispatchQueue, onEOF: @escaping () -> Void) {
        self.input = input
        self.queue = queue
        self.onEOF = onEOF
    }

    deinit {
        cancel()
    }

    func start() {
        lock.lock()
        guard source == nil, !didFinish else {
            lock.unlock()
            return
        }
        let source = DispatchSource.makeReadSource(
            fileDescriptor: input.fileDescriptor,
            queue: queue
        )
        self.source = source
        lock.unlock()

        source.setEventHandler { [weak self] in
            self?.handleReadableInput()
        }
        source.resume()
    }

    func cancel() {
        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        let source = source
        self.source = nil
        lock.unlock()
        source?.cancel()
    }

    private func handleReadableInput() {
        let reachedEOF: Bool
        do {
            reachedEOF = try input.read(upToCount: 1)?.isEmpty ?? true
        } catch {
            reachedEOF = true
        }
        guard reachedEOF else {
            return
        }

        lock.lock()
        guard !didFinish else {
            lock.unlock()
            return
        }
        didFinish = true
        let source = source
        self.source = nil
        lock.unlock()
        source?.cancel()
        onEOF()
    }
}

private enum HostError: LocalizedError {
    case invalidArguments
    case coreAudio(operation: String, status: OSStatus)
    case processUnavailable(Int32)
    case unsupportedFormat
    case unsupportedSystem

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Use `list` or `record <pid> <output.wav> [--audible]`."
        case .coreAudio(let operation, let status):
            return "CoreAudio returned OSStatus \(status) while calling \(operation). Grant VOIVOX system-audio recording permission in System Settings, then try again."
        case .processUnavailable(let pid):
            return "No CoreAudio process object exists for pid \(pid)."
        case .unsupportedFormat:
            return "CoreAudio returned an unsupported tap format."
        case .unsupportedSystem:
            return "VOIVOX per-app capture requires macOS 14.2 or newer."
        }
    }
}

func tapInputBuffer(_ inputData: UnsafePointer<AudioBufferList>?) -> UnsafePointer<AudioBufferList>? {
    inputData
}

@available(macOS 14.2, *)
private final class ProcessTapFileRecorder {
    private let configuration: ProcessTapConfiguration
    private let outputURL: URL
    private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
    private var ioProcID: AudioDeviceIOProcID?
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var tapDescription: CATapDescription?
    private var outputFile: AVAudioFile?
    private var format: AVAudioFormat?

    init(configuration: ProcessTapConfiguration, outputURL: URL) throws {
        self.configuration = configuration
        self.outputURL = outputURL
    }

    deinit {
        stop()
    }

    func start() throws {
        let processObjectID = try translate(pid: configuration.pid)
        let description = CATapDescription(monoMixdownOfProcesses: [processObjectID])
        description.name = "VOIVOX \(configuration.pid)"
        description.isPrivate = true
        description.muteBehavior = configuration.keepsPlaybackAudible
            ? CATapMuteBehavior.unmuted
            : CATapMuteBehavior.mutedWhenTapped
        tapDescription = description

        try check(AudioHardwareCreateProcessTap(description, &tapID), whileCalling: "AudioHardwareCreateProcessTap")
        let tapUID = try propertyString(objectID: tapID, selector: kAudioTapPropertyUID)
        try createAggregateDevice(tapUID: tapUID)

        var streamDescription = try propertyStreamDescription(objectID: tapID, selector: kAudioTapPropertyFormat)
        guard let audioFormat = AVAudioFormat(streamDescription: &streamDescription) else {
            throw HostError.unsupportedFormat
        }
        format = audioFormat
        outputFile = try AVAudioFile(forWriting: outputURL, settings: audioFormat.settings)

        let queue = DispatchQueue(label: "VOIVOX.ProcessTap.IO", qos: .userInitiated)
        try check(AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateDeviceID, queue) { [weak self] _, inputData, _, _, _ in
            self?.write(tapInputBuffer(inputData))
        }, whileCalling: "AudioDeviceCreateIOProcIDWithBlock")
        guard let ioProcID else {
            throw HostError.coreAudio(operation: "AudioDeviceCreateIOProcIDWithBlock", status: kAudioHardwareUnspecifiedError)
        }
        try check(AudioDeviceStart(aggregateDeviceID, ioProcID), whileCalling: "AudioDeviceStart")
    }

    func stop() {
        if let ioProcID, aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) {
            _ = AudioDeviceStop(aggregateDeviceID, ioProcID)
            _ = AudioDeviceDestroyIOProcID(aggregateDeviceID, ioProcID)
        }
        ioProcID = nil
        outputFile = nil
        format = nil
        if aggregateDeviceID != AudioObjectID(kAudioObjectUnknown) {
            _ = AudioHardwareDestroyAggregateDevice(aggregateDeviceID)
            aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            _ = AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
        tapDescription = nil
    }

    private func write(_ inputData: UnsafePointer<AudioBufferList>?) {
        guard let inputData, let format, let outputFile else { return }
        let byteCount = Int(inputData.pointee.mBuffers.mDataByteSize)
        let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
        guard byteCount > 0, bytesPerFrame > 0 else { return }
        let frameCount = AVAudioFrameCount(byteCount / bytesPerFrame)
        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: format,
            bufferListNoCopy: UnsafeMutablePointer(mutating: inputData),
            deallocator: nil
        ) else { return }
        buffer.frameLength = frameCount
        try? outputFile.write(from: buffer)
    }

    private func translate(pid: Int32) throws -> AudioObjectID {
        var processID = pid_t(pid)
        var processObjectID = AudioObjectID(kAudioObjectUnknown)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(
            AudioObjectGetPropertyData(
                AudioObjectID(kAudioObjectSystemObject),
                &address,
                UInt32(MemoryLayout<pid_t>.size),
                &processID,
                &size,
                &processObjectID
            ),
            whileCalling: "AudioObjectGetPropertyData(TranslatePIDToProcessObject)"
        )
        guard processObjectID != AudioObjectID(kAudioObjectUnknown) else { throw HostError.processUnavailable(pid) }
        return processObjectID
    }

    private func createAggregateDevice(tapUID: String) throws {
        let properties: [String: Any] = [
            kAudioAggregateDeviceNameKey: "VOIVOX Process Tap",
            kAudioAggregateDeviceUIDKey: "io.voivox.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: false,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: tapUID,
                kAudioSubTapDriftCompensationKey: true
            ]]
        ]
        try check(AudioHardwareCreateAggregateDevice(properties as CFDictionary, &aggregateDeviceID), whileCalling: "AudioHardwareCreateAggregateDevice")
    }

    private func propertyString(objectID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> String {
        var value: CFString?
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        try withUnsafeMutableBytes(of: &value) { buffer in
            try check(
                AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, buffer.baseAddress!),
                whileCalling: "AudioObjectGetPropertyData(String)"
            )
        }
        guard let value else { throw HostError.unsupportedFormat }
        return value as String
    }

    private func propertyStreamDescription(objectID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> AudioStreamBasicDescription {
        var value = AudioStreamBasicDescription()
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(
            AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value),
            whileCalling: "AudioObjectGetPropertyData(StreamDescription)"
        )
        return value
    }

    private func check(_ status: OSStatus, whileCalling operation: String) throws {
        guard status == noErr else { throw HostError.coreAudio(operation: operation, status: status) }
    }
}

private func printJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
