import AppKit
import CoreGraphics
import VoiceVACCore

@MainActor
struct ScreenSnapshot {
    let identity: ObjectIdentifier
    let directDisplayID: CGDirectDisplayID?
    let frame: CGRect
    let visibleFrame: CGRect
    let backingScaleFactor: CGFloat
}

private struct ScreenLogicalFingerprint: Hashable {
    let frameX: CGFloat
    let frameY: CGFloat
    let frameWidth: CGFloat
    let frameHeight: CGFloat
    let backingScaleFactor: CGFloat

    init(_ snapshot: ScreenSnapshot) {
        frameX = snapshot.frame.origin.x
        frameY = snapshot.frame.origin.y
        frameWidth = snapshot.frame.width
        frameHeight = snapshot.frame.height
        backingScaleFactor = snapshot.backingScaleFactor
    }
}

@MainActor
struct ScreenDescriptorResolver {
    private var fallbackIDs: [ObjectIdentifier: ScreenID] = [:]
    private var priorFallbackIDs: [ScreenLogicalFingerprint: [ScreenID]] = [:]
    private var nextFallbackRawValue = UInt32.max

    mutating func resolve(_ snapshots: [ScreenSnapshot]) -> [ScreenDescriptor] {
        guard !snapshots.isEmpty else { return [] }
        let directIDCounts = Dictionary(grouping: snapshots.compactMap { snapshot -> UInt32? in
            guard let directID = snapshot.directDisplayID, directID != kCGNullDirectDisplay else {
                return nil
            }
            return directID
        }, by: { $0 }).mapValues(\.count)
        let reservedDirectIDs = Set(directIDCounts.keys)
        var assignedIDs = Set<ScreenID>()
        var currentFallbackIDs: [ScreenLogicalFingerprint: [ScreenID]] = [:]

        let descriptors = snapshots.map { snapshot in
            let fingerprint = ScreenLogicalFingerprint(snapshot)
            let screenID: ScreenID
            let usesFallback: Bool
            if let preservedFallback = preservedFallbackID(
                for: snapshot.identity,
                fingerprint: fingerprint,
                reservedDirectIDs: reservedDirectIDs,
                assignedIDs: assignedIDs
            ) {
                screenID = preservedFallback
                usesFallback = true
            } else if let directID = snapshot.directDisplayID,
               directID != kCGNullDirectDisplay,
               directIDCounts[directID] == 1,
               !assignedIDs.contains(ScreenID(rawValue: directID))
            {
                screenID = ScreenID(rawValue: directID)
                usesFallback = false
            } else {
                screenID = allocateFallbackID(
                    for: snapshot.identity,
                    reservedDirectIDs: reservedDirectIDs,
                    assignedIDs: assignedIDs
                )
                usesFallback = true
            }
            assignedIDs.insert(screenID)
            if usesFallback {
                currentFallbackIDs[fingerprint, default: []].append(screenID)
            }

            return ScreenDescriptor(
                id: screenID,
                frame: snapshot.frame,
                visibleFrame: snapshot.visibleFrame,
                backingScaleFactor: snapshot.backingScaleFactor
            )
        }
        priorFallbackIDs = currentFallbackIDs
        return descriptors
    }

    private mutating func preservedFallbackID(
        for identity: ObjectIdentifier,
        fingerprint: ScreenLogicalFingerprint,
        reservedDirectIDs: Set<UInt32>,
        assignedIDs: Set<ScreenID>
    ) -> ScreenID? {
        if let existing = fallbackIDs[identity],
           isAvailableFallback(
               existing,
               reservedDirectIDs: reservedDirectIDs,
               assignedIDs: assignedIDs
           )
        {
            return existing
        }
        guard let logicalMatch = priorFallbackIDs[fingerprint]?.first(where: {
            isAvailableFallback(
                $0,
                reservedDirectIDs: reservedDirectIDs,
                assignedIDs: assignedIDs
            )
        }) else {
            return nil
        }
        fallbackIDs[identity] = logicalMatch
        return logicalMatch
    }

    private func isAvailableFallback(
        _ candidate: ScreenID,
        reservedDirectIDs: Set<UInt32>,
        assignedIDs: Set<ScreenID>
    ) -> Bool {
        !reservedDirectIDs.contains(candidate.rawValue)
            && !assignedIDs.contains(candidate)
    }

    private mutating func allocateFallbackID(
        for identity: ObjectIdentifier,
        reservedDirectIDs: Set<UInt32>,
        assignedIDs: Set<ScreenID>
    ) -> ScreenID {
        while reservedDirectIDs.contains(nextFallbackRawValue)
            || assignedIDs.contains(ScreenID(rawValue: nextFallbackRawValue))
        {
            nextFallbackRawValue &-= 1
        }
        let fallback = ScreenID(rawValue: nextFallbackRawValue)
        nextFallbackRawValue &-= 1
        fallbackIDs[identity] = fallback
        return fallback
    }
}

@MainActor
final class NSScreenProvider: NSObject, ScreenProviding {
    private let notificationCenter: NotificationCenter
    private var resolver = ScreenDescriptorResolver()
    private(set) var screens: [ScreenDescriptor] = []
    private(set) var preferredScreenID: ScreenID?
    var onScreensChanged: (() -> Void)?

    init(notificationCenter: NotificationCenter = .default) {
        self.notificationCenter = notificationCenter
        super.init()
        refresh()
        notificationCenter.addObserver(
            self,
            selector: #selector(screenParametersDidChange(_:)),
            name: NSApplication.didChangeScreenParametersNotification,
            object: nil
        )
    }

    deinit {
        notificationCenter.removeObserver(self)
    }

    @objc
    private func screenParametersDidChange(_ notification: Notification) {
        refresh()
        onScreensChanged?()
    }

    private func refresh() {
        let physicalScreens = NSScreen.screens
        let snapshots = physicalScreens.map {
            ScreenSnapshot(
                identity: ObjectIdentifier($0),
                directDisplayID: $0.cgDirectDisplayID,
                frame: $0.frame,
                visibleFrame: $0.visibleFrame,
                backingScaleFactor: $0.backingScaleFactor
            )
        }
        screens = resolver.resolve(snapshots)

        if let mainScreen = NSScreen.main,
           let index = physicalScreens.firstIndex(where: { $0 === mainScreen }),
           screens.indices.contains(index)
        {
            preferredScreenID = screens[index].id
        } else {
            preferredScreenID = screens.first?.id
        }
    }
}
