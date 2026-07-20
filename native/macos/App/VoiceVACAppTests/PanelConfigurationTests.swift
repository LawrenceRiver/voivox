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

    func testPanelsUseExactSizesAndHoseRendersAboveTheGlassBelowTheMouth() {
        let capsule = CapsulePanel(frame: capsuleFrame)
        let nozzle = NozzleHitPanel(frame: nozzleFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)
        let hose = HoseOverlayPanel(
            screenID: ScreenID(rawValue: 41),
            frame: CGRect(x: -1440, y: -120, width: 1440, height: 900)
        )

        XCTAssertEqual(capsule.frame.size, CGSize(width: 406, height: 116))
        XCTAssertEqual(nozzle.frame.size, CGSize(width: 96, height: 96))
        XCTAssertEqual(transcript.frame.size, CGSize(width: 318, height: 74))
        XCTAssertGreaterThan(hose.level.rawValue, capsule.level.rawValue)
        XCTAssertLessThan(hose.level.rawValue, nozzle.level.rawValue)
        XCTAssertEqual(capsule.level.rawValue, 4)
        XCTAssertEqual(nozzle.level.rawValue, 6)
        XCTAssertEqual(transcript.level.rawValue, 7)
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

    func testDeployedNozzleUsesTheWholeRemotePresentationViewport() {
        let nozzle = NozzleHitPanel(frame: nozzleFrame)

        nozzle.setDeployed(
            center: CGPoint(x: 400, y: 280),
            hoseTangent: CGVector(dx: 1, dy: 0),
            showsCloseButton: true
        )

        // The remote duckbill is a deliberate 3D object, not a tiny icon
        // stranded in a larger transparent hit panel. Its RealityKit viewport
        // must grow with the deployed panel so the mouth remains readable at
        // desktop scale and usable as a drag target.
        XCTAssertEqual(nozzle.nozzleRealityView.frame.size, NozzleHitPanel.deployedSize)
        XCTAssertEqual(nozzle.interactionView.frame.size, NozzleHitPanel.deployedSize)
        XCTAssertTrue(nozzle.contentView?.layer?.masksToBounds ?? false)
        XCTAssertTrue(nozzle.nozzleRealityView.layer?.masksToBounds ?? false)
    }

    func testEmbeddedMouthInputUsesTheNozzlePanelAndNeverCreatesASecondBubble() {
        let nozzle = NozzleHitPanel(frame: nozzleFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)

        nozzle.setEmbeddedURLInputPresented(true)

        XCTAssertTrue(nozzle.canBecomeKey)
        XCTAssertFalse(nozzle.canBecomeMain)
        XCTAssertTrue(nozzle.becomesKeyOnlyIfNeeded)
        XCTAssertTrue(nozzle.embeddedURLInputView.isDescendant(of: try! XCTUnwrap(nozzle.contentView)))
        XCTAssertFalse(nozzle.embeddedURLInputView.isHidden)
        XCTAssertGreaterThanOrEqual(nozzle.embeddedURLInputView.frame.width, 280)
        XCTAssertLessThanOrEqual(nozzle.embeddedURLInputView.frame.width, 320)
        XCTAssertEqual(nozzle.frame.size, NozzleHitPanel.urlInputSize)
        let placeholderColor = nozzle.embeddedURLInputView.urlField
            .placeholderAttributedString?
            .attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        XCTAssertGreaterThan(placeholderColor?.whiteComponent ?? 0, 0.9)
        let startColor = nozzle.embeddedURLInputView.startButton.attributedTitle
            .attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor
        XCTAssertGreaterThan(startColor?.whiteComponent ?? 0, 0.9)
        XCTAssertTrue(transcript.canBecomeKey)
        XCTAssertFalse(transcript.canBecomeMain)
        XCTAssertTrue(transcript.becomesKeyOnlyIfNeeded)
    }

    func testAuxiliaryPanelsBeginHiddenUntilTheCoordinatorSelectsOne() {
        let nozzle = NozzleHitPanel(frame: nozzleFrame)
        let transcript = TranscriptPanel(frame: transcriptFrame)

        XCTAssertTrue(nozzle.embeddedURLInputView.isHidden)
        XCTAssertFalse(transcript.isVisible)
    }

    func testCapsuleUsesRealClearLiquidGlassAndHostsChildrenInContentView() {
        let capsule = CapsulePanel(frame: capsuleFrame)
        let glass = try! XCTUnwrap(capsule.contentView as? CapsuleGlassView)

        XCTAssertEqual(glass.style, .clear)
        XCTAssertEqual(glass.cornerRadius, 58)
        let tintAlpha = try! XCTUnwrap(glass.tintColor?.usingColorSpace(.deviceRGB)?.alphaComponent)
        XCTAssertEqual(tintAlpha, 0.12, accuracy: 0.001)
        XCTAssertTrue(glass.dragSurface.isDescendant(of: try! XCTUnwrap(glass.contentView)))
        XCTAssertTrue(glass.dragSurface.autoresizingMask.contains([.width, .height]))
        XCTAssertTrue(glass.glassEdgeView.isDescendant(of: try! XCTUnwrap(glass.contentView)))
        XCTAssertNil(glass.glassEdgeView.hitTest(CGPoint(x: 203, y: 58)))

        let outerAlpha = try! XCTUnwrap(
            CapsuleGlassEdgeView.outerStrokeColor.usingColorSpace(.deviceRGB)?.alphaComponent
        )
        let innerAlpha = try! XCTUnwrap(
            CapsuleGlassEdgeView.innerStrokeColor.usingColorSpace(.deviceRGB)?.alphaComponent
        )
        XCTAssertGreaterThanOrEqual(outerAlpha, 0.15, "dark hairline must survive a white webpage")
        XCTAssertGreaterThanOrEqual(innerAlpha, 0.70, "white catchlight must survive a dark video")
        XCTAssertLessThanOrEqual(CapsuleGlassEdgeView.outerLineWidth, 1.5)
        XCTAssertLessThanOrEqual(CapsuleGlassEdgeView.innerLineWidth, 1)
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
        let projection = CapsuleControlLayout.projection

        XCTAssertEqual(CapsuleDragSurfaceView.nozzleHitFrame, projection.portHitFrame)
        XCTAssertEqual(CapsuleDragSurfaceView.buttonHitFrame, projection.buttonHitFrame)
        XCTAssertEqual(glass.physicalButton.frame, projection.buttonHitFrame)
        XCTAssertFalse(glass.dragSurface.canBeginDrag(at: projection.portAnchor))
        XCTAssertFalse(glass.dragSurface.canBeginDrag(at: projection.buttonAnchor))
        XCTAssertTrue(glass.dragSurface.canBeginDrag(at: CGPoint(x: 203, y: 58)))
        XCTAssertTrue(glass.dragSurface.canBeginDrag(at: CGPoint(x: 48, y: 58)))
        XCTAssertTrue(glass.dragSurface.canBeginDrag(at: CGPoint(x: 358, y: 58)))
    }

    private func makePanels() -> [NSPanel] {
        [
            HoseOverlayPanel(screenID: ScreenID(rawValue: 41), frame: CGRect(x: -1440, y: -120, width: 1440, height: 900)),
            CapsulePanel(frame: capsuleFrame),
            NozzleHitPanel(frame: nozzleFrame),
            TranscriptPanel(frame: transcriptFrame),
        ]
    }
}
