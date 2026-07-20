import AppKit
import CoreGraphics
import Foundation
import simd
import VoiceVACCore

/// Screen-space relation between the user-held suction head and the hose.
/// The point being dragged is the centre of the visible duckbill, while the
/// tube must meet its exposed rear cylinder rather than disappear underneath
/// the model. The default authored nozzle points downward on screen.
enum NozzlePresentationKinematics {
    static let rearCylinderOffset: CGFloat = 28

    static func normalizedTangent(_ tangent: CGVector) -> CGVector {
        let length = hypot(tangent.dx, tangent.dy)
        guard length > 0.000_1 else { return CGVector(dx: 0, dy: -1) }
        return CGVector(dx: tangent.dx / length, dy: tangent.dy / length)
    }

    static func rearCylinderPoint(
        forNozzleCenter center: CGPoint,
        hoseTangent: CGVector
    ) -> CGPoint {
        let tangent = normalizedTangent(hoseTangent)
        return CGPoint(
            x: center.x - tangent.dx * rearCylinderOffset,
            y: center.y - tangent.dy * rearCylinderOffset
        )
    }

    static func screenRotation(forHoseTangent tangent: CGVector) -> CGFloat {
        let tangent = normalizedTangent(tangent)
        let rawAngle = atan2(tangent.dy, tangent.dx) + .pi / 2
        return atan2(sin(rawAngle), cos(rawAngle))
    }
}

@MainActor
final class NozzleDragCoordinator: NSObject, NSDraggingSource {
    typealias DeploymentHandler = @MainActor (_ point: CGPoint, _ progress: CGFloat, _ tangent: CGVector) -> Void

    private let store: VoiceVACStore
    private let hoseSession: HoseRenderSession?
    private let dockPoint: CGPoint
    private let deploymentHandler: DeploymentHandler?
    private(set) var activeSessionID: UUID?
    private(set) var lastSimulationError: Error?

    init(
        store: VoiceVACStore,
        hoseSession: HoseRenderSession?,
        dockPoint: CGPoint,
        deploymentHandler: DeploymentHandler? = nil
    ) {
        self.store = store
        self.hoseSession = hoseSession
        self.dockPoint = dockPoint
        self.deploymentHandler = deploymentHandler
        super.init()
    }

    @discardableResult
    func beginDragging(
        from hostView: NSView,
        event: NSEvent,
        sessionID: UUID,
        nonce: Data,
        nozzleFrame: CGRect
    ) throws -> NSDraggingSession {
        try beginDragging(
            from: hostView,
            event: event,
            token: NozzleDragToken(sessionID: sessionID, nonce: nonce),
            nozzleFrame: nozzleFrame
        )
    }

    @discardableResult
    func beginDragging(
        from hostView: NSView,
        event: NSEvent,
        token: NozzleDragToken,
        nozzleFrame: CGRect
    ) throws -> NSDraggingSession {
        let item = try makeDraggingItem(token: token, frame: nozzleFrame)
        let globalPoint = NSEvent.mouseLocation
        activeSessionID = token.sessionID
        store.send(.beginNozzleDrag(at: globalPoint, attemptID: token.sessionID))
        updateDeployment(to: globalPoint)
        let session = hostView.beginDraggingSession(with: [item], event: event, source: self)
        session.animatesToStartingPositionsOnCancelOrFail = false
        session.draggingFormation = .none
        return session
    }

    func makeDraggingItem(
        sessionID: UUID,
        nonce: Data,
        frame: CGRect
    ) throws -> NSDraggingItem {
        let writer = try NozzlePasteboard.makePasteboardItem(sessionID: sessionID, nonce: nonce)
        let item = NSDraggingItem(pasteboardWriter: writer)
        item.setDraggingFrame(frame, contents: Self.nozzleDragImage(size: frame.size))
        return item
    }

    func makeDraggingItem(token: NozzleDragToken, frame: CGRect) throws -> NSDraggingItem {
        let writer = try NozzlePasteboard.makePasteboardItem(token: token)
        let item = NSDraggingItem(pasteboardWriter: writer)
        item.setDraggingFrame(frame, contents: Self.nozzleDragImage(size: frame.size))
        return item
    }

    func draggingSession(
        _ session: NSDraggingSession,
        sourceOperationMaskFor context: NSDraggingContext
    ) -> NSDragOperation {
        .copy
    }

    func ignoreModifierKeys(for session: NSDraggingSession) -> Bool { true }

    func draggingSession(_ session: NSDraggingSession, movedTo screenPoint: NSPoint) {
        guard activeSessionID != nil else { return }
        store.send(.moveNozzle(to: screenPoint))
        updateDeployment(to: screenPoint)
    }

    func draggingSession(
        _ session: NSDraggingSession,
        endedAt screenPoint: NSPoint,
        operation: NSDragOperation
    ) {
        guard activeSessionID != nil else { return }
        store.send(.moveNozzle(to: screenPoint))
        updateDeployment(to: screenPoint)
        if operation.isEmpty, let attemptID = activeSessionID {
            store.send(.targetRejected(
                VoiceVACFailure(
                    code: .noPlayableMedia,
                    message: "No playable video found"
                ),
                attemptID: attemptID
            ))
        }
        activeSessionID = nil
        // A failed drop intentionally stays deployed. Chrome resolution or an explicit
        // retract/new drag is the only authority that changes warningYellow.
    }

    static func mouthRotation(dragProgress: CGFloat) -> CGFloat {
        min(max(dragProgress, 0), 1) * (.pi / 2)
    }

    private func updateDeployment(to point: CGPoint) {
        let distance = hypot(point.x - dockPoint.x, point.y - dockPoint.y)
        let tangent = distance > 0
            ? CGVector(dx: (point.x - dockPoint.x) / distance, dy: (point.y - dockPoint.y) / distance)
            : CGVector(dx: 0, dy: 1)
        deploymentHandler?(
            point,
            min(max(distance / 120, 0), 1),
            tangent
        )
        guard let hoseSession else { return }
        do {
            try hoseSession.deployVisual(
                toward: NozzlePresentationKinematics.rearCylinderPoint(
                    forNozzleCenter: point,
                    hoseTangent: tangent
                ),
                orientation: simd_quatd(
                    angle: Double(NozzlePresentationKinematics.screenRotation(forHoseTangent: tangent)),
                    axis: SIMD3(0, 0, 1)
                )
            )
            lastSimulationError = nil
        } catch {
            lastSimulationError = error
        }
    }

    private static func nozzleDragImage(size: CGSize) -> NSImage {
        // AppKit still requires dragging contents, but all visible drag feedback is the
        // independent RealityKit nozzle panel. This image is intentionally transparent.
        NSImage(size: size)
    }
}
