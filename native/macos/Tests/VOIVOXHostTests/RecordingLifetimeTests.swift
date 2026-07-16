import Foundation
import XCTest
@testable import VOIVOXHost

final class RecordingLifetimeTests: XCTestCase {
    func testStandardInputEOFRequestsRecordingStop() async throws {
        let pipe = Pipe()
        let stopped = expectation(description: "recording stopped after parent pipe EOF")
        let monitor = StandardInputEOFMonitor(
            input: pipe.fileHandleForReading,
            queue: DispatchQueue(label: "VOIVOXHostTests.parent-pipe")
        ) {
            stopped.fulfill()
        }

        monitor.start()
        try pipe.fileHandleForWriting.close()

        await fulfillment(of: [stopped], timeout: 1)
        monitor.cancel()
    }

    func testRecordingStopIsIdempotentAcrossCompetingTriggers() {
        var teardownCount = 0
        var completionCount = 0
        let stop = RecordingStopCoordinator(
            teardown: { teardownCount += 1 },
            completion: { completionCount += 1 }
        )

        stop.requestStop()
        stop.requestStop()

        XCTAssertEqual(teardownCount, 1)
        XCTAssertEqual(completionCount, 1)
    }
}
