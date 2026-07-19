import AppKit
import VoiceVACCore
import XCTest
@testable import Voice_VAC

@MainActor
final class PanelConfigurationTests: XCTestCase {
    private let capsuleFrame = CGRect(x: 900, y: 120, width: 406, height: 116)
    private let nozzleFrame = CGRect(x: 910, y: 130, width: 96, height: 96)
    private let transcriptFrame = CGRect(x: 988, y: 248, width: 318, height: 74)

    func testEveryPanelUsesTheTransparentNonactivatingStickyContract() {
        let panels = makePanels()
        let requiredBehavior: NSWindow.CollectionBehavior = [
            .canJoinAllApplications,
            .canJoinAllSpaces,
            .transient,
            .ignoresCycle,
            .fullScreenAuxiliary,
        ]

        for panel in panels {
            XCTAssertEqual(panel.styleMask, [.borderless, .nonactivatingPanel], "\(type(of: panel))")
            XCTAssertFalse(panel.isOpaque, "\(type(of: panel))")
            XCTAssertEqual(panel.backgroundColor, .clear, "\(type(of: panel))")
            XCTAssertFalse(panel.hidesOnDeactivate, "\(type(of: panel))")
            XCTAssertFalse(panel.canHide, "\(type(of: panel))")
            XCTAssertTrue(panel.isFloatingPanel, "\(type(of: panel))")
            XCTAssertFalse(panel.isReleasedWhenClosed, "\(type(of: panel))")
            XCTAssertTrue(panel.isExcludedFromWindowsMenu, "\(type(of: panel))")
            XCTAssertEqual(panel.animationBehavior, .none, "\(type(of: panel))")
            XCTAssertEqual(
                panel.collectionBehavior.intersection(requiredBehavior),
                requiredBehavior,
                "\(type(of: panel))"
            )
            XCTAssertFalse(panel.collectionBehavior.contains(.auxiliary), "\(type(of: panel))")
        }
    }

    func testPanelsUseExactSizesAndStrictLevelsBelowModalPanel() {
        let capsule = CapsulePanel(frame: capsuleFrame)
        let nozzle = NozzleHitPanel(frame: nozzleFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)
        let urlInput = URLInputPanel(frame: transcriptFrame)
        let hose = HoseOverlayPanel(
            screenID: ScreenID(rawValue: 41),
            frame: CGRect(x: -1440, y: -120, width: 1440, height: 900)
        )

        XCTAssertEqual(capsule.frame.size, CGSize(width: 406, height: 116))
        XCTAssertEqual(nozzle.frame.size, CGSize(width: 96, height: 96))
        XCTAssertEqual(transcript.frame.size, CGSize(width: 318, height: 74))
        XCTAssertEqual(hose.level.rawValue, 3)
        XCTAssertEqual(capsule.level.rawValue, 4)
        XCTAssertEqual(nozzle.level.rawValue, 5)
        XCTAssertEqual(transcript.level.rawValue, 6)
        XCTAssertEqual(urlInput.level.rawValue, 7)
        XCTAssertLessThan(urlInput.level.rawValue, NSWindow.Level.modalPanel.rawValue)
        XCTAssertNotEqual(hose.level, NSWindow.Level.screenSaver)
        XCTAssertNotEqual(hose.level, NSWindow.Level.popUpMenu)
    }

    func testOnlyHoseIsClickThroughAndHasNoRectangularBacking() {
        let panels = makePanels()
        let hose = try! XCTUnwrap(panels.first { $0 is HoseOverlayPanel })

        XCTAssertTrue(hose.ignoresMouseEvents)
        XCTAssertFalse(hose.hasShadow)
        XCTAssertNil(hose.contentView?.layer?.backgroundColor)

        for panel in panels where panel !== hose {
            XCTAssertFalse(panel.ignoresMouseEvents, "\(type(of: panel))")
        }
    }

    func testURLAndTranscriptHaveDeliberateKeyButNeverMainBehavior() {
        let urlInput = URLInputPanel(frame: transcriptFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)

        XCTAssertTrue(urlInput.canBecomeKey)
        XCTAssertFalse(urlInput.canBecomeMain)
        XCTAssertTrue(urlInput.becomesKeyOnlyIfNeeded)
        XCTAssertTrue(transcript.canBecomeKey)
        XCTAssertFalse(transcript.canBecomeMain)
        XCTAssertTrue(transcript.becomesKeyOnlyIfNeeded)
    }

    func testAuxiliaryPanelsBeginHiddenUntilTheCoordinatorSelectsOne() {
        let urlInput = URLInputPanel(frame: transcriptFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)

        XCTAssertFalse(urlInput.isVisible)
        XCTAssertFalse(transcript.isVisible)
    }

    func testCapsuleUsesRealClearLiquidGlassAndHostsChildrenInContentView() {
        let capsule = CapsulePanel(frame: capsuleFrame)
        let glass = try! XCTUnwrap(capsule.contentView as? CapsuleGlassView)

        XCTAssertEqual(glass.style, .clear)
        XCTAssertEqual(glass.cornerRadius, 58)
        let tintAlpha = try! XCTUnwrap(glass.tintColor?.usingColorSpace(.deviceRGB)?.alphaComponent)
        XCTAssertEqual(tintAlpha, 0.08, accuracy: 0.001)
        XCTAssertTrue(glass.dragSurface.isDescendant(of: try! XCTUnwrap(glass.contentView)))
        XCTAssertTrue(glass.dragSurface.autoresizingMask.contains([.width, .height]))
    }

    func testTranscriptUsesRealClearLiquidGlassAndExactContentLayout() {
        let transcript = TranscriptPanel(frame: transcriptFrame)
        let glass = try! XCTUnwrap(transcript.contentView as? TranscriptGlassView)

        XCTAssertEqual(glass.style, .clear)
        XCTAssertEqual(glass.cornerRadius, 37)
        XCTAssertEqual(glass.frame.size, CGSize(width: 318, height: 74))
        XCTAssertEqual(glass.contentView?.frame, CGRect(origin: .zero, size: CGSize(width: 318, height: 74)))
    }

    func testCapsuleDragSurfaceRejectsNozzleAndButtonHitRegions() {
        let glass = CapsuleGlassView(frame: CGRect(origin: .zero, size: CGSize(width: 406, height: 116)))

        XCTAssertFalse(glass.dragSurface.canBeginDrag(at: CGPoint(x: 48, y: 58)))
        XCTAssertTrue(glass.dragSurface.canBeginDrag(at: CGPoint(x: 203, y: 58)))
        XCTAssertFalse(glass.dragSurface.canBeginDrag(at: CGPoint(x: 358, y: 58)))
    }

    private func makePanels() -> [NSPanel] {
        [
            HoseOverlayPanel(screenID: ScreenID(rawValue: 41), frame: CGRect(x: -1440, y: -120, width: 1440, height: 900)),
            CapsulePanel(frame: capsuleFrame),
            NozzleHitPanel(frame: nozzleFrame),
            TranscriptPanel(frame: transcriptFrame),
            URLInputPanel(frame: transcriptFrame),
        ]
    }
}
