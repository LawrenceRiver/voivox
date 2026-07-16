import Foundation
import Testing

@Test("record reads the PID and output path after its command name")
func recordCommandReadsArgumentsAfterAction() throws {
    let packageDirectory = URL(filePath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
    let executable = packageDirectory.appending(path: ".build/debug/voivox-host")
    let stderr = Pipe()
    let process = Process()
    process.executableURL = executable
    process.arguments = ["record", "2147483647", "/tmp/voivox-command-parsing.wav"]
    process.standardError = stderr

    try process.run()
    process.waitUntilExit()

    let message = String(decoding: stderr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    #expect(process.terminationStatus == 1)
    #expect(message.contains("invalidArguments") == false)
    #expect(message.contains("Use `list` or `record") == false)
    #expect(message.contains("No CoreAudio process object exists for pid 2147483647") == true)
}
