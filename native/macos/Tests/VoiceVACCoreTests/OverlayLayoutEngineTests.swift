import CoreGraphics
import Testing
@testable import VoiceVACCore

@Suite("Voice VAC overlay layout")
struct OverlayLayoutEngineTests {
    @Test("default capsule is 24 points from the main screen bottom right")
    func defaultPlacement() {
        let screen = ScreenDescriptor(
            id: ScreenID(rawValue: 1),
            frame: CGRect(x: 0, y: 0, width: 1710, height: 1107),
            visibleFrame: CGRect(x: 0, y: 80, width: 1710, height: 1003),
            backingScaleFactor: 2
        )
        let layout = OverlayLayoutEngine().makeLayout(
            screens: [screen],
            preferredScreenID: nil,
            savedPlacement: nil
        )

        #expect(layout.capsuleFrame.size == CGSize(width: 406, height: 116))
        #expect(layout.capsuleFrame.maxX == screen.visibleFrame.maxX - 24)
        #expect(layout.capsuleFrame.minY == screen.visibleFrame.minY + 24)
        #expect(layout.hoseFrames == [screen.id: screen.frame])
    }

    @Test("normalized placement resolves on a negative-coordinate monitor")
    func negativeCoordinateMonitor() {
        let main = screen(
            id: 1,
            frame: CGRect(x: 0, y: 0, width: 1710, height: 1107)
        )
        let left = screen(
            id: 2,
            frame: CGRect(x: -1440, y: 25, width: 1440, height: 900),
            visibleFrame: CGRect(x: -1440, y: 25, width: 1440, height: 875)
        )
        let placement = CapsulePlacement(
            screenID: left.id,
            normalizedOrigin: CGPoint(x: 0.25, y: 0.75)
        )

        let layout = OverlayLayoutEngine().makeLayout(
            screens: [main, left],
            preferredScreenID: nil,
            savedPlacement: placement
        )
        let expectedX = left.visibleFrame.minX + 24
            + 0.25 * (left.visibleFrame.width - 48 - 406)
        let expectedY = left.visibleFrame.minY + 24
            + 0.75 * (left.visibleFrame.height - 48 - 116)

        #expect(layout.capsuleScreenID == left.id)
        #expect(layout.capsuleFrame.origin == CGPoint(x: expectedX, y: expectedY))
        #expect(layout.hoseFrames[left.id] == left.frame)
    }

    @Test("a disconnected saved screen falls back to the preferred connected screen")
    func disconnectedSavedScreen() {
        let main = screen(
            id: 1,
            frame: CGRect(x: 0, y: 0, width: 1710, height: 1107)
        )
        let right = screen(
            id: 2,
            frame: CGRect(x: 1710, y: -120, width: 1280, height: 1024)
        )
        let disconnected = CapsulePlacement(
            screenID: ScreenID(rawValue: 99),
            normalizedOrigin: CGPoint(x: 0, y: 1)
        )

        let layout = OverlayLayoutEngine().makeLayout(
            screens: [main, right],
            preferredScreenID: right.id,
            savedPlacement: disconnected
        )

        #expect(layout.capsuleScreenID == right.id)
        #expect(layout.capsuleFrame.maxX == right.visibleFrame.maxX - 24)
        #expect(layout.capsuleFrame.minY == right.visibleFrame.minY + 24)
    }

    @Test("offscreen normalized coordinates are clamped into the visible frame")
    func clampsOffscreenPlacement() {
        let screen = screen(
            id: 7,
            frame: CGRect(x: -2560, y: -200, width: 2560, height: 1440),
            visibleFrame: CGRect(x: -2560, y: -176, width: 2560, height: 1416)
        )
        let offscreen = CapsulePlacement(
            screenID: screen.id,
            normalizedOrigin: CGPoint(x: -4, y: 8)
        )

        let layout = OverlayLayoutEngine().makeLayout(
            screens: [screen],
            preferredScreenID: nil,
            savedPlacement: offscreen
        )

        #expect(layout.capsuleFrame.minX == screen.visibleFrame.minX + 24)
        #expect(layout.capsuleFrame.maxY == screen.visibleFrame.maxY - 24)
        #expect(screen.visibleFrame.contains(layout.capsuleFrame))
    }

    @Test("layout uses points independently of screen backing scale")
    func scaleFactorIndependence() {
        let frame = CGRect(x: 0, y: 40, width: 1512, height: 942)
        let oneX = screen(id: 1, frame: frame, backingScaleFactor: 1)
        let twoX = screen(id: 1, frame: frame, backingScaleFactor: 2)
        let placement = CapsulePlacement(
            screenID: oneX.id,
            normalizedOrigin: CGPoint(x: 0.4, y: 0.6)
        )
        let engine = OverlayLayoutEngine()

        let oneXLayout = engine.makeLayout(
            screens: [oneX],
            preferredScreenID: nil,
            savedPlacement: placement
        )
        let twoXLayout = engine.makeLayout(
            screens: [twoX],
            preferredScreenID: nil,
            savedPlacement: placement
        )

        #expect(oneXLayout.capsuleFrame == twoXLayout.capsuleFrame)
    }

    @Test("transcript moves below a top-docked capsule on the same screen")
    func transcriptMovesBelowTopCapsule() {
        let screen = screen(
            id: 4,
            frame: CGRect(x: -1200, y: 80, width: 1200, height: 800)
        )
        let layout = OverlayLayoutEngine().makeLayout(
            screens: [screen],
            preferredScreenID: nil,
            savedPlacement: CapsulePlacement(
                screenID: screen.id,
                normalizedOrigin: CGPoint(x: 0.5, y: 1)
            )
        )

        #expect(layout.transcriptFrame.maxY == layout.capsuleFrame.minY - 12)
        #expect(screen.visibleFrame.contains(layout.transcriptFrame))
    }

    @Test("transcript is clamped inside a constrained visible frame")
    func transcriptClampsToVisibleFrame() {
        let screen = screen(
            id: 5,
            frame: CGRect(x: 0, y: 50, width: 900, height: 180)
        )
        let layout = OverlayLayoutEngine().makeLayout(
            screens: [screen],
            preferredScreenID: nil,
            savedPlacement: CapsulePlacement(
                screenID: screen.id,
                normalizedOrigin: CGPoint(x: 0.5, y: 0.5)
            )
        )

        #expect(screen.visibleFrame.contains(layout.transcriptFrame))
    }

    @Test("phase-one overlay metrics remain exact")
    func exactMetrics() {
        #expect(OverlayMetrics.phaseOne.capsuleSize == CGSize(width: 406, height: 116))
        #expect(OverlayMetrics.phaseOne.edgeInset == 24)
        #expect(OverlayMetrics.phaseOne.nozzleHitSize == CGSize(width: 96, height: 96))
        #expect(OverlayMetrics.phaseOne.transcriptSize == CGSize(width: 318, height: 74))
        #expect(OverlayMetrics.phaseOne.transcriptGap == 12)
    }

    private func screen(
        id: UInt32,
        frame: CGRect,
        visibleFrame: CGRect? = nil,
        backingScaleFactor: CGFloat = 2
    ) -> ScreenDescriptor {
        ScreenDescriptor(
            id: ScreenID(rawValue: id),
            frame: frame,
            visibleFrame: visibleFrame ?? frame,
            backingScaleFactor: backingScaleFactor
        )
    }
}
