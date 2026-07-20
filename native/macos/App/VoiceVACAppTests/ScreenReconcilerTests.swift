import AppKit
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class ScreenReconcilerTests: XCTestCase {
    func testProductionCompositionPublishesDockedCoreHoseWhenOverlayStarts() throws {
        let main = screen(2)
        let source = HoseRenderSnapshotSource()
        let session = HoseRenderSession(source: source, seed: 82)
        let fixture = makeFixture(
            screens: [main],
            preferred: main.id,
            hoseRenderSession: session
        )

        fixture.coordinator.start(with: VoiceVACStore())

        let renderSnapshot = try XCTUnwrap(source.latest)
        let nozzleFrame = try XCTUnwrap(fixture.factory.panel(for: .nozzle)?.frame)
        let tip = renderSnapshot.jointMatrices.last!.columns.3
        XCTAssertEqual(tip.x, Float(nozzleFrame.midX / 1_000), accuracy: 0.000_1)
        XCTAssertEqual(tip.y, Float(nozzleFrame.midY / 1_000), accuracy: 0.000_1)
    }

    func testScreenDescriptorResolverGuardsNullAndDuplicateDisplayIDsWithStableFallbacks() {
        let duplicateA = NSObject()
        let duplicateB = NSObject()
        let missing = NSObject()
        let valid = NSObject()
        var resolver = ScreenDescriptorResolver()
        let first = resolver.resolve([
            snapshot(duplicateA, directDisplayID: 10, x: 0),
            snapshot(duplicateB, directDisplayID: 10, x: 1000),
            snapshot(missing, directDisplayID: kCGNullDirectDisplay, x: 2000),
            snapshot(valid, directDisplayID: 12, x: 3000),
        ])
        let second = resolver.resolve([
            snapshot(missing, directDisplayID: nil, x: 2100),
            snapshot(duplicateB, directDisplayID: 10, x: 1100),
            snapshot(valid, directDisplayID: 12, x: 3100),
            snapshot(duplicateA, directDisplayID: 10, x: 100),
        ])
        let afterDuplicatePeerDisconnects = resolver.resolve([
            snapshot(duplicateA, directDisplayID: 10, x: 200),
            snapshot(valid, directDisplayID: 12, x: 3200),
        ])

        XCTAssertEqual(Set(first.map(\.id)).count, 4)
        XCTAssertEqual(first[3].id, ScreenID(rawValue: 12))
        XCTAssertEqual(second[2].id, ScreenID(rawValue: 12))
        XCTAssertEqual(first[0].id, second[3].id)
        XCTAssertEqual(first[1].id, second[1].id)
        XCTAssertEqual(first[2].id, second[0].id)
        XCTAssertEqual(first[0].id, afterDuplicatePeerDisconnects[0].id)
    }

    func testFallbackScreenIDSurvivesAReplacementWrapperForTheSameLogicalDisplay() {
        let oldWrapper = NSObject()
        let replacementWrapper = NSObject()
        let distinctWrapper = NSObject()
        var resolver = ScreenDescriptorResolver()

        let first = resolver.resolve([
            snapshot(oldWrapper, directDisplayID: nil, x: -1440),
        ])
        let second = resolver.resolve([
            snapshot(replacementWrapper, directDisplayID: nil, x: -1440),
            snapshot(distinctWrapper, directDisplayID: nil, x: 0),
        ])

        XCTAssertEqual(second[0].id, first[0].id)
        XCTAssertNotEqual(second[1].id, second[0].id)
    }

    func testFallbackScreenIDSurvivesAnEmptyRoundAndVisibleFrameChange() {
        let oldWrapper = NSObject()
        let replacementWrapper = NSObject()
        var resolver = ScreenDescriptorResolver()

        let first = resolver.resolve([
            snapshot(oldWrapper, directDisplayID: nil, x: 0, visibleInset: 40),
        ])
        XCTAssertTrue(resolver.resolve([]).isEmpty)
        let afterTransientEmpty = resolver.resolve([
            snapshot(replacementWrapper, directDisplayID: nil, x: 0, visibleInset: 80),
        ])

        XCTAssertEqual(afterTransientEmpty[0].id, first[0].id)
    }

    func testAmbiguousLogicalFingerprintsNeverAliasAndResolveDeterministically() {
        let oldA = NSObject()
        let oldB = NSObject()
        let newA = NSObject()
        let newB = NSObject()
        var resolver = ScreenDescriptorResolver()
        let first = resolver.resolve([
            snapshot(oldA, directDisplayID: nil, x: 0),
            snapshot(oldB, directDisplayID: nil, x: 0),
        ])
        let second = resolver.resolve([
            snapshot(newA, directDisplayID: nil, x: 0),
            snapshot(newB, directDisplayID: nil, x: 0),
        ])

        XCTAssertEqual(Set(first.map(\.id)).count, 2)
        XCTAssertEqual(Set(second.map(\.id)).count, 2)
        XCTAssertEqual(second.map(\.id), first.map(\.id))
    }

    func testCreatesOneExactHosePerScreenAndNeverAUnionOverlay() {
        let left = screen(1, frame: CGRect(x: -1440, y: -120, width: 1440, height: 900))
        let main = screen(2, frame: CGRect(x: 0, y: 0, width: 1710, height: 1107))
        let fixture = makeFixture(screens: [left, main], preferred: main.id)

        fixture.coordinator.start(with: VoiceVACStore())

        let hoses = fixture.factory.created.filter { if case .hose = $0.role { true } else { false } }
        XCTAssertEqual(hoses.count, 2)
        XCTAssertEqual(hoses.first { $0.role == .hose(left.id) }?.frame, left.frame)
        XCTAssertEqual(hoses.first { $0.role == .hose(main.id) }?.frame, main.frame)
        XCTAssertFalse(hoses.contains { $0.frame == left.frame.union(main.frame) })
    }

    func testRepeatedIdenticalChangesAreIdempotentAndPreserveEveryPanelIdentity() {
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id)
        fixture.coordinator.start(with: VoiceVACStore())
        let original = Dictionary(uniqueKeysWithValues: fixture.factory.created.map { ($0.role, ObjectIdentifier($0)) })

        fixture.provider.notifyChange()
        fixture.provider.notifyChange()

        XCTAssertEqual(fixture.factory.created.count, original.count)
        for panel in fixture.factory.created {
            XCTAssertEqual(ObjectIdentifier(panel), original[panel.role])
            XCTAssertEqual(panel.closeCallCount, 0)
        }
    }

    func testAddingAndRemovingScreensOnlyCreatesAndClosesChangedHoses() {
        let main = screen(2)
        let left = screen(1, frame: CGRect(x: -1440, y: -120, width: 1440, height: 900))
        let right = screen(3, frame: CGRect(x: 1710, y: 120, width: 1512, height: 982))
        let fixture = makeFixture(screens: [main, left], preferred: main.id)
        fixture.coordinator.start(with: VoiceVACStore())
        let mainHose = fixture.factory.panel(for: .hose(main.id))
        let removedHose = fixture.factory.panel(for: .hose(left.id))

        fixture.provider.screens = [main, right]
        fixture.provider.notifyChange()

        XCTAssertTrue(fixture.factory.panel(for: .hose(main.id)) === mainHose)
        XCTAssertEqual(removedHose?.orderOutCallCount, 1)
        XCTAssertEqual(removedHose?.closeCallCount, 1)
        XCTAssertEqual(fixture.factory.createCount(for: .hose(right.id)), 1)
        XCTAssertEqual(fixture.factory.createCount(for: .hose(main.id)), 1)
    }

    func testNegativeCoordinateScreenFrameIsPreservedExactly() {
        let negative = screen(9, frame: CGRect(x: -2560, y: -480, width: 2560, height: 1440))
        let fixture = makeFixture(screens: [negative], preferred: negative.id)

        fixture.coordinator.start(with: VoiceVACStore())

        XCTAssertEqual(fixture.factory.panel(for: .hose(negative.id))?.frame, negative.frame)
    }

    func testTransientEmptyScreenListIsIgnoredSafely() {
        let fixture = makeFixture(screens: [], preferred: nil)

        fixture.coordinator.start(with: VoiceVACStore())
        fixture.provider.notifyChange()

        XCTAssertTrue(fixture.factory.created.isEmpty)
    }

    func testDisconnectedSavedPlacementFallsBackClampsAndRewritesPersistence() {
        let defaults = CountingUserDefaults()
        let store = CapsulePlacementStore(defaults: defaults)
        store.save(CapsulePlacement(screenID: ScreenID(rawValue: 99), normalizedOrigin: CGPoint(x: 3, y: -2)))
        defaults.setCallCount = 0
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id, placementStore: store)

        fixture.coordinator.start(with: VoiceVACStore())

        let corrected = store.load()
        XCTAssertEqual(corrected?.screenID, main.id)
        XCTAssertEqual(corrected?.normalizedOrigin, CGPoint(x: 1, y: 0))
        XCTAssertEqual(defaults.setCallCount, 1)
    }

    func testReconciliationOrdersEveryRoleDeterministically() {
        let first = screen(7)
        let second = screen(2, frame: CGRect(x: -1000, y: 0, width: 1000, height: 800))
        let fixture = makeFixture(screens: [first, second], preferred: first.id)

        fixture.coordinator.start(with: VoiceVACStore())

        XCTAssertEqual(
            fixture.factory.showEvents,
            [.hose(second.id), .hose(first.id), .capsule, .nozzle]
        )
    }

    func testIdleVisibilityShowsOnlyTheCoreMachinePanels() {
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id)

        fixture.coordinator.start(with: VoiceVACStore())

        XCTAssertTrue(try! XCTUnwrap(fixture.factory.panel(for: .hose(main.id))).isVisible)
        XCTAssertTrue(try! XCTUnwrap(fixture.factory.panel(for: .capsule)).isVisible)
        XCTAssertTrue(try! XCTUnwrap(fixture.factory.panel(for: .nozzle)).isVisible)
        XCTAssertFalse(try! XCTUnwrap(fixture.factory.panel(for: .transcript)).isVisible)
    }

    func testTranscriptAndURLInputAreMutuallyExclusive() {
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id)
        let store = VoiceVACStore(
            state: VoiceVACState(phase: .transcribing, transcriptPreview: "first words")
        )
        fixture.coordinator.start(with: store)

        let transcript = try! XCTUnwrap(fixture.factory.panel(for: .transcript))
        XCTAssertTrue(transcript.isVisible)

        fixture.coordinator.setURLInputPresented(true)

        XCTAssertFalse(transcript.isVisible)
        XCTAssertEqual(fixture.coordinator.auxiliaryPresentation, .urlInput)

        fixture.coordinator.setURLInputPresented(false)

        XCTAssertTrue(transcript.isVisible)
    }

    func testTranscriptVisibilityTracksPreviewChangesWithoutShowingURLInput() async {
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id)
        let store = VoiceVACStore()
        fixture.coordinator.start(with: store)
        let transcript = try! XCTUnwrap(fixture.factory.panel(for: .transcript))

        store.send(.transcriptPreviewChanged("captured speech"))
        await Task.yield()

        XCTAssertTrue(transcript.isVisible)
    }

    func testBackgroundDragMovesAndClampsButPersistsOnlyOnMouseUp() {
        let defaults = CountingUserDefaults()
        let store = CapsulePlacementStore(defaults: defaults)
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id, placementStore: store)
        fixture.coordinator.start(with: VoiceVACStore())
        defaults.setCallCount = 0
        let capsule = try! XCTUnwrap(fixture.factory.panel(for: .capsule))
        let initialOrigin = capsule.frame.origin

        fixture.coordinator.beginCapsuleDrag(at: CGPoint(x: 1200, y: 200))
        fixture.coordinator.dragCapsule(to: CGPoint(x: -10_000, y: 50_000))

        XCTAssertNotEqual(capsule.frame.origin, initialOrigin)
        XCTAssertGreaterThanOrEqual(capsule.frame.minX, main.visibleFrame.minX + 24)
        XCTAssertLessThanOrEqual(capsule.frame.maxY, main.visibleFrame.maxY - 24)
        XCTAssertEqual(defaults.setCallCount, 0)

        fixture.coordinator.endCapsuleDrag(at: CGPoint(x: -10_000, y: 50_000))

        XCTAssertEqual(defaults.setCallCount, 1)
        XCTAssertNotNil(store.load())
    }

    func testDockedNozzleFollowsTheCapsuleEvenWhenTheStatusIsNotIdle() {
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id)
        // A message or yellow warning must not turn a still-docked nozzle into
        // a detached desktop window. Attachment is a visual relationship, not
        // an inference from the transcription state machine.
        fixture.coordinator.start(with: VoiceVACStore(
            state: VoiceVACState(phase: .warningYellow)
        ))
        let capsule = try! XCTUnwrap(fixture.factory.panel(for: .capsule))
        let nozzle = try! XCTUnwrap(fixture.factory.panel(for: .nozzle))
        let originalOffset = CGPoint(
            x: nozzle.frame.minX - capsule.frame.minX,
            y: nozzle.frame.minY - capsule.frame.minY
        )

        fixture.coordinator.beginCapsuleDrag(at: CGPoint(x: 1_200, y: 200))
        fixture.coordinator.dragCapsule(to: CGPoint(x: 1_040, y: 310))

        XCTAssertEqual(nozzle.frame.minX - capsule.frame.minX, originalOffset.x, accuracy: 0.001)
        XCTAssertEqual(nozzle.frame.minY - capsule.frame.minY, originalOffset.y, accuracy: 0.001)
    }

    func testFactoryInstalledDragHandlersRespectBackgroundHitTesting() {
        let defaults = CountingUserDefaults()
        let store = CapsulePlacementStore(defaults: defaults)
        let main = screen(2)
        let fixture = makeFixture(screens: [main], preferred: main.id, placementStore: store)
        fixture.coordinator.start(with: VoiceVACStore())
        let capsule = try! XCTUnwrap(fixture.factory.panel(for: .capsule))
        let handlers = try! XCTUnwrap(capsule.dragHandlers)
        let initial = capsule.frame.origin

        handlers.began(CGPoint(x: 1400, y: 200))
        handlers.changed(CGPoint(x: 1300, y: 300))
        handlers.ended(CGPoint(x: 1300, y: 300))

        XCTAssertNotEqual(capsule.frame.origin, initial)
        XCTAssertEqual(defaults.setCallCount, 1)
    }

    private func makeFixture(
        screens: [ScreenDescriptor],
        preferred: ScreenID?,
        placementStore: CapsulePlacementStore? = nil,
        hoseRenderSession: HoseRenderSession? = nil
    ) -> Fixture {
        let provider = FakeScreenProvider(screens: screens, preferredScreenID: preferred)
        let factory = RecordingPanelFactory()
        let defaults = CountingUserDefaults()
        let coordinator = OverlayCoordinator(
            screenProvider: provider,
            panelFactory: factory,
            layoutEngine: OverlayLayoutEngine(),
            placementStore: placementStore ?? CapsulePlacementStore(defaults: defaults),
            hoseRenderSession: hoseRenderSession
        )
        return Fixture(coordinator: coordinator, provider: provider, factory: factory)
    }

    private func screen(
        _ id: UInt32,
        frame: CGRect = CGRect(x: 0, y: 0, width: 1710, height: 1107)
    ) -> ScreenDescriptor {
        ScreenDescriptor(
            id: ScreenID(rawValue: id),
            frame: frame,
            visibleFrame: frame.insetBy(dx: 0, dy: 40),
            backingScaleFactor: 2
        )
    }

    private func snapshot(
        _ object: NSObject,
        directDisplayID: CGDirectDisplayID?,
        x: CGFloat,
        visibleInset: CGFloat = 40
    ) -> ScreenSnapshot {
        ScreenSnapshot(
            identity: ObjectIdentifier(object),
            directDisplayID: directDisplayID,
            frame: CGRect(x: x, y: 0, width: 1000, height: 800),
            visibleFrame: CGRect(
                x: x,
                y: visibleInset,
                width: 1000,
                height: 800 - visibleInset
            ),
            backingScaleFactor: 2
        )
    }
}

@MainActor
private struct Fixture {
    let coordinator: OverlayCoordinator
    let provider: FakeScreenProvider
    let factory: RecordingPanelFactory
}

@MainActor
private final class FakeScreenProvider: ScreenProviding {
    var screens: [ScreenDescriptor]
    var preferredScreenID: ScreenID?
    var onScreensChanged: (() -> Void)?

    init(screens: [ScreenDescriptor], preferredScreenID: ScreenID?) {
        self.screens = screens
        self.preferredScreenID = preferredScreenID
    }

    func notifyChange() {
        onScreensChanged?()
    }
}

@MainActor
private final class RecordingPanelFactory: PanelFactory {
    private(set) var created: [RecordingPanel] = []
    private(set) var showEvents: [PanelRole] = []

    func makePanel(
        for role: PanelRole,
        frame: CGRect,
        capsuleDragHandlers: CapsuleDragHandlers?
    ) -> any PanelControlling {
        let panel = RecordingPanel(
            role: role,
            frame: frame,
            dragHandlers: capsuleDragHandlers,
            show: { [weak self] role in self?.showEvents.append(role) }
        )
        created.append(panel)
        return panel
    }

    func panel(for role: PanelRole) -> RecordingPanel? {
        created.last { $0.role == role }
    }

    func createCount(for role: PanelRole) -> Int {
        created.count { $0.role == role }
    }
}

@MainActor
private final class RecordingPanel: PanelControlling {
    let role: PanelRole
    var frame: CGRect
    let dragHandlers: CapsuleDragHandlers?
    private let showClosure: (PanelRole) -> Void
    private(set) var isVisible = false
    private(set) var orderOutCallCount = 0
    private(set) var closeCallCount = 0

    init(
        role: PanelRole,
        frame: CGRect,
        dragHandlers: CapsuleDragHandlers?,
        show: @escaping (PanelRole) -> Void
    ) {
        self.role = role
        self.frame = frame
        self.dragHandlers = dragHandlers
        self.showClosure = show
    }

    func setFrame(_ frame: CGRect) {
        self.frame = frame
    }

    func orderFrontRegardless() {
        isVisible = true
        showClosure(role)
    }

    func orderOut() {
        isVisible = false
        orderOutCallCount += 1
    }

    func close() {
        isVisible = false
        closeCallCount += 1
    }
}

private final class CountingUserDefaults: UserDefaults, @unchecked Sendable {
    var setCallCount = 0

    init() {
        let suiteName = "VoiceVAC.ScreenReconcilerTests.\(UUID().uuidString)"
        super.init(suiteName: suiteName)!
        removePersistentDomain(forName: suiteName)
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func set(_ value: Any?, forKey defaultName: String) {
        if defaultName == CapsulePlacementStore.storageKey {
            setCallCount += 1
        }
        super.set(value, forKey: defaultName)
    }
}
