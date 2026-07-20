import CoreGraphics

public struct OverlayLayoutEngine: Sendable {
    public let metrics: OverlayMetrics

    public init(metrics: OverlayMetrics = .phaseOne) {
        self.metrics = metrics
    }

    public func makeLayout(
        screens: [ScreenDescriptor],
        preferredScreenID: ScreenID?,
        savedPlacement: CapsulePlacement?
    ) -> OverlayLayout {
        precondition(!screens.isEmpty, "Overlay layout requires at least one screen")

        let savedScreen = savedPlacement.flatMap { placement in
            screens.first { $0.id == placement.screenID }
        }
        let preferredScreen = preferredScreenID.flatMap { id in
            screens.first { $0.id == id }
        }
        let capsuleScreen = savedScreen ?? preferredScreen ?? screens[0]
        let normalizedOrigin = savedScreen == nil
            ? CGPoint(x: 1, y: 0)
            : savedPlacement?.normalizedOrigin ?? CGPoint(x: 1, y: 0)
        let capsuleOrigin = resolveOrigin(
            normalizedOrigin,
            in: capsuleScreen.visibleFrame
        )
        let capsuleFrame = CGRect(origin: capsuleOrigin, size: metrics.capsuleSize)

        let controlProjection: DeviceControlProjection
        do {
            controlProjection = try VoiceVACDevicePresentationDesign.makeControlProjection(
                viewport: metrics.capsuleSize,
                hitTargetSize: metrics.nozzleHitSize
            )
        } catch {
            preconditionFailure("Invalid Voice VAC control projection: \(error)")
        }
        let nozzleHitFrame = controlProjection.portHitFrame.offsetBy(
            dx: capsuleFrame.minX,
            dy: capsuleFrame.minY
        )
        let transcriptFrame = makeTranscriptFrame(
            capsuleFrame: capsuleFrame,
            visibleFrame: capsuleScreen.visibleFrame
        )

        return OverlayLayout(
            capsuleScreenID: capsuleScreen.id,
            capsuleFrame: capsuleFrame,
            hoseFrames: Dictionary(uniqueKeysWithValues: screens.map { ($0.id, $0.frame) }),
            nozzleHitFrame: nozzleHitFrame,
            transcriptFrame: transcriptFrame
        )
    }

    public func placement(
        forCapsuleFrame capsuleFrame: CGRect,
        on screen: ScreenDescriptor
    ) -> CapsulePlacement {
        let minimumX = screen.visibleFrame.minX + metrics.edgeInset
        let minimumY = screen.visibleFrame.minY + metrics.edgeInset
        let horizontalTravel = max(
            0,
            screen.visibleFrame.width - (2 * metrics.edgeInset) - metrics.capsuleSize.width
        )
        let verticalTravel = max(
            0,
            screen.visibleFrame.height - (2 * metrics.edgeInset) - metrics.capsuleSize.height
        )
        let normalizedX = horizontalTravel == 0
            ? 0
            : clampedUnit((capsuleFrame.minX - minimumX) / horizontalTravel)
        let normalizedY = verticalTravel == 0
            ? 0
            : clampedUnit((capsuleFrame.minY - minimumY) / verticalTravel)

        return CapsulePlacement(
            screenID: screen.id,
            normalizedOrigin: CGPoint(x: normalizedX, y: normalizedY)
        )
    }

    private func resolveOrigin(
        _ normalizedOrigin: CGPoint,
        in visibleFrame: CGRect
    ) -> CGPoint {
        let minimumX = visibleFrame.minX + metrics.edgeInset
        let minimumY = visibleFrame.minY + metrics.edgeInset
        let horizontalTravel = max(
            0,
            visibleFrame.width - (2 * metrics.edgeInset) - metrics.capsuleSize.width
        )
        let verticalTravel = max(
            0,
            visibleFrame.height - (2 * metrics.edgeInset) - metrics.capsuleSize.height
        )

        return CGPoint(
            x: minimumX + clampedUnit(normalizedOrigin.x) * horizontalTravel,
            y: minimumY + clampedUnit(normalizedOrigin.y) * verticalTravel
        )
    }

    private func makeTranscriptFrame(
        capsuleFrame: CGRect,
        visibleFrame: CGRect
    ) -> CGRect {
        let minimumX = visibleFrame.minX + metrics.edgeInset
        let maximumX = visibleFrame.maxX - metrics.edgeInset - metrics.transcriptSize.width
        let minimumY = visibleFrame.minY + metrics.edgeInset
        let maximumY = visibleFrame.maxY - metrics.edgeInset - metrics.transcriptSize.height
        let x = clamped(
            capsuleFrame.maxX - metrics.transcriptSize.width,
            lowerBound: minimumX,
            upperBound: maximumX
        )
        let aboveY = capsuleFrame.maxY + metrics.transcriptGap
        let belowY = capsuleFrame.minY - metrics.transcriptGap - metrics.transcriptSize.height
        let y: CGFloat

        if aboveY <= maximumY {
            y = aboveY
        } else if belowY >= minimumY {
            y = belowY
        } else {
            y = clamped(aboveY, lowerBound: minimumY, upperBound: maximumY)
        }

        return CGRect(origin: CGPoint(x: x, y: y), size: metrics.transcriptSize)
    }

    private func clamped(
        _ value: CGFloat,
        lowerBound: CGFloat,
        upperBound: CGFloat
    ) -> CGFloat {
        guard upperBound >= lowerBound else { return lowerBound }
        return min(max(value, lowerBound), upperBound)
    }

    private func clampedUnit(_ value: CGFloat) -> CGFloat {
        guard value.isFinite else { return 0 }
        return min(max(value, 0), 1)
    }
}
