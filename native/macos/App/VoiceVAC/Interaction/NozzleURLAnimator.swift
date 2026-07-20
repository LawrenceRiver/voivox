import AppKit
import CoreGraphics
import Foundation

enum NozzleURLAnimationStage: Int, CaseIterable, Equatable {
    case retreatAndRotateHorizontal
    case straightLift
    case turnMouthTowardUser
    case expandMouthAndInput
}

struct NozzleURLKeyframe: Equatable {
    let stage: NozzleURLAnimationStage
    let startTime: TimeInterval
    let duration: TimeInterval
}

struct NozzleURLAnimationFrame: Equatable {
    let stage: NozzleURLAnimationStage
    let stageProgress: CGFloat
    let translation: CGPoint
    /// Positive values travel away from the camera, deeper into the desktop.
    let depthRetreat: CGFloat
    /// Interpolates the front-facing vertical dock into the horizontal operating pose.
    let operatingPoseProgress: CGFloat
    /// Straight screen-space rise from the capsule port, in points.
    let verticalLift: CGFloat
    /// Late screen-X turn that presents the dark mouth to the user.
    let mouthTurnProgress: CGFloat
    /// X scale applied only to the authored duckbill subtree.
    let mouthExpansion: CGFloat
    let inputOpacity: CGFloat
    let showsEmbeddedInput: Bool
}

struct NozzleURLAnimator {
    let timeline: [NozzleURLKeyframe] = [
        .init(stage: .retreatAndRotateHorizontal, startTime: 0.00, duration: 0.18),
        .init(stage: .straightLift, startTime: 0.18, duration: 0.24),
        .init(stage: .turnMouthTowardUser, startTime: 0.42, duration: 0.16),
        .init(stage: .expandMouthAndInput, startTime: 0.58, duration: 0.20),
    ]

    var duration: TimeInterval {
        guard let final = timeline.last else { return 0 }
        return final.startTime + final.duration
    }

    func frame(at requestedTime: TimeInterval) -> NozzleURLAnimationFrame {
        let time = min(max(requestedTime, 0), duration)
        let keyframe = timeline.last(where: { time >= $0.startTime }) ?? timeline[0]
        let rawProgress = keyframe.duration > 0
            ? (time - keyframe.startTime) / keyframe.duration
            : 1
        let progress = CGFloat(min(max(rawProgress, 0), 1))
        let eased = smoothStep(progress)

        switch keyframe.stage {
        case .retreatAndRotateHorizontal:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: .zero,
                depthRetreat: 0.052 * eased,
                operatingPoseProgress: eased,
                verticalLift: 0,
                mouthTurnProgress: 0,
                mouthExpansion: 1,
                inputOpacity: 0,
                showsEmbeddedInput: false
            )
        case .straightLift:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(x: 0, y: 96 * eased),
                depthRetreat: 0.052,
                operatingPoseProgress: 1,
                verticalLift: 96 * eased,
                mouthTurnProgress: 0,
                mouthExpansion: 1,
                inputOpacity: 0,
                showsEmbeddedInput: false
            )
        case .turnMouthTowardUser:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(x: 0, y: 96),
                depthRetreat: 0.052,
                operatingPoseProgress: 1,
                verticalLift: 96,
                mouthTurnProgress: eased,
                mouthExpansion: 1,
                inputOpacity: 0,
                showsEmbeddedInput: false
            )
        case .expandMouthAndInput:
            let inputProgress = min(max((eased - 0.42) / 0.58, 0), 1)
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(x: 0, y: 96),
                depthRetreat: 0.052,
                operatingPoseProgress: 1,
                verticalLift: 96,
                mouthTurnProgress: 1,
                mouthExpansion: 1 + 1.35 * eased,
                inputOpacity: inputProgress,
                showsEmbeddedInput: inputProgress > 0
            )
        }
    }

    private func smoothStep(_ value: CGFloat) -> CGFloat {
        value * value * (3 - 2 * value)
    }
}

@MainActor
final class NozzleURLInputView: NSView, NSTextFieldDelegate {
    final class PresentedTextField: NSTextField {
        var permitsFirstResponder = false
        override var acceptsFirstResponder: Bool { permitsFirstResponder && super.acceptsFirstResponder }
    }

    let urlField = PresentedTextField()
    let startButton = NSButton(title: "Start", target: nil, action: nil)
    private let onSubmit: (URL) -> Void

    init(onSubmit: @escaping (URL) -> Void) {
        self.onSubmit = onSubmit
        super.init(frame: CGRect(x: 0, y: 0, width: 300, height: 44))
        isHidden = true
        setAccessibilityIdentifier("voice-vac-embedded-mouth-input")

        let fieldFont = NSFont.systemFont(ofSize: 13, weight: .medium)
        urlField.placeholderAttributedString = NSAttributedString(
            string: "Paste video link",
            attributes: [
                .font: fieldFont,
                .foregroundColor: NSColor.white.withAlphaComponent(0.62),
            ]
        )
        urlField.setAccessibilityIdentifier("voice-vac-url-field")
        urlField.setAccessibilityLabel("Video URL")
        urlField.delegate = self
        urlField.isBezeled = false
        urlField.drawsBackground = false
        urlField.focusRingType = .none
        urlField.textColor = .white
        urlField.font = fieldFont
        urlField.frame = CGRect(x: 16, y: 6, width: 220, height: 32)
        urlField.autoresizingMask = [.width]
        addSubview(urlField)

        startButton.bezelStyle = .texturedRounded
        startButton.attributedTitle = NSAttributedString(
            string: "Start",
            attributes: [
                .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                .foregroundColor: NSColor.white,
            ]
        )
        startButton.setAccessibilityIdentifier("voice-vac-url-start")
        startButton.setAccessibilityLabel("Start URL transcription")
        startButton.target = self
        startButton.action = #selector(submitFromStartButton)
        startButton.contentTintColor = .white
        startButton.frame = CGRect(x: 240, y: 6, width: 52, height: 32)
        startButton.autoresizingMask = [.minXMargin]
        addSubview(startButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    func setPresented(_ presented: Bool) {
        isHidden = !presented
        urlField.permitsFirstResponder = presented
        urlField.isEnabled = presented
        startButton.isEnabled = presented
        if presented {
            window?.makeKey()
            window?.makeFirstResponder(urlField)
        } else if window?.firstResponder === urlField.currentEditor() || window?.firstResponder === urlField {
            window?.makeFirstResponder(nil)
        }
    }

    func control(
        _ control: NSControl,
        textView: NSTextView,
        doCommandBy commandSelector: Selector
    ) -> Bool {
        guard commandSelector == #selector(NSResponder.insertNewline(_:)) else { return false }
        submit()
        return true
    }

    @objc private func submitFromStartButton() { submit() }

    private func submit() {
        guard !isHidden,
              let url = URL(string: urlField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "http" || url.scheme == "https"
        else { return }
        onSubmit(url)
    }
}
