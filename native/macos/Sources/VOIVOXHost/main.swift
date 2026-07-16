import AVFoundation
import AppKit
import CoreAudio
import Foundation

@main
struct VOIVOXHost {
    static func main() {
        do {
            let command = CommandLine.arguments.dropFirst()
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
            FileHandle.standardError.write(Data("VOIVOX host error: \(error)\n".utf8))
            exit(1)
        }
    }

    private static func runningApplications() throws -> [[String: Any]] {
        var result: [[String: Any]] = []
        for application in NSWorkspace.shared.runningApplications where application.processIdentifier > 0 && !application.isTerminated {
            let pid = application.processIdentifier
            let name = application.localizedName ?? "Process \(pid)"
            let bundleID = application.bundleIdentifier ?? ""
            result.append(["pid": pid, "name": name, "bundleId": bundleID])
        }
        return result
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

        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        signal(SIGINT, SIG_IGN)
        interrupt.setEventHandler {
            recorder.stop()
            try? printJSON(["event": "stopped", "output": outputPath])
            exit(0)
        }
        interrupt.resume()
        RunLoop.current.run()
    }
}

private enum HostError: LocalizedError {
    case invalidArguments
    case coreAudio(OSStatus)
    case processUnavailable(Int32)
    case unsupportedFormat
    case unsupportedSystem

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Use `list` or `record <pid> <output.wav> [--audible]`."
        case .coreAudio(let status):
            return "CoreAudio returned OSStatus \(status). Grant VOIVOX system-audio recording permission in System Settings, then try again."
        case .processUnavailable(let pid):
            return "No CoreAudio process object exists for pid \(pid)."
        case .unsupportedFormat:
            return "CoreAudio returned an unsupported tap format."
        case .unsupportedSystem:
            return "VOIVOX per-app capture requires macOS 14.2 or newer."
        }
    }
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
        description.muteBehavior = configuration.keepsPlaybackAudible ? CATapMuteBehavior.unmuted : CATapMuteBehavior.muted
        tapDescription = description

        try check(AudioHardwareCreateProcessTap(description, &tapID))
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
            self?.write(inputData)
        })
        guard let ioProcID else { throw HostError.coreAudio(kAudioHardwareUnspecifiedError) }
        try check(AudioDeviceStart(aggregateDeviceID, ioProcID))
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
        var pid = pid
        var processObjectID = AudioObjectID(kAudioObjectUnknown)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<AudioValueTranslation>.size)
        try withUnsafeMutableBytes(of: &pid) { inputBuffer in
            try withUnsafeMutableBytes(of: &processObjectID) { outputBuffer in
                var translation = AudioValueTranslation(
                    mInputData: inputBuffer.baseAddress!,
                    mInputDataSize: UInt32(MemoryLayout<Int32>.size),
                    mOutputData: outputBuffer.baseAddress!,
                    mOutputDataSize: UInt32(MemoryLayout<AudioObjectID>.size)
                )
                try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &translation))
            }
        }
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
        try check(AudioHardwareCreateAggregateDevice(properties as CFDictionary, &aggregateDeviceID))
    }

    private func propertyString(objectID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> String {
        var value: CFString?
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<CFString?>.size)
        try withUnsafeMutableBytes(of: &value) { buffer in
            try check(AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, buffer.baseAddress!))
        }
        guard let value else { throw HostError.unsupportedFormat }
        return value as String
    }

    private func propertyStreamDescription(objectID: AudioObjectID, selector: AudioObjectPropertySelector) throws -> AudioStreamBasicDescription {
        var value = AudioStreamBasicDescription()
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try check(AudioObjectGetPropertyData(objectID, &address, 0, nil, &size, &value))
        return value
    }

    private func check(_ status: OSStatus) throws {
        guard status == noErr else { throw HostError.coreAudio(status) }
    }
}

private func printJSON(_ value: Any) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}
