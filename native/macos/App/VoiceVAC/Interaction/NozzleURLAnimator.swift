import AppKit
import CoreGraphics
import Foundation

enum NozzleURLAnimationStage: Int, CaseIterable, Equatable {
    case unlockAndLift
    case rotateInPlane
    case cExtension
    case reverseSCurlAndInput
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
    let lift: CGFloat
    let mouthRotation: CGFloat
    let cCurl: CGFloat
    let reverseSCurl: CGFloat
    let inputOpacity: CGFloat
    let showsURLInput: Bool
}

struct NozzleURLAnimator {
    let timeline: [NozzleURLKeyframe] = [
        .init(stage: .unlockAndLift, startTime: 0.00, duration: 0.12),
        .init(stage: .rotateInPlane, startTime: 0.12, duration: 0.14),
        .init(stage: .cExtension, startTime: 0.26, duration: 0.22),
        .init(stage: .reverseSCurlAndInput, startTime: 0.48, duration: 0.24),
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
        case .unlockAndLift:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(x: 0, y: 18 * eased),
                lift: 18 * eased,
                mouthRotation: 0,
                cCurl: 0,
                reverseSCurl: 0,
                inputOpacity: 0,
                showsURLInput: false
            )
        case .rotateInPlane:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(x: 0, y: 18),
                lift: 18,
                mouthRotation: (.pi / 2) * eased,
                cCurl: 0,
                reverseSCurl: 0,
                inputOpacity: 0,
                showsURLInput: false
            )
        case .cExtension:
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(
                    x: 112 * eased,
                    y: 18 + sin(.pi * eased) * 30
                ),
                lift: 18,
                mouthRotation: .pi / 2,
                cCurl: eased,
                reverseSCurl: 0,
                inputOpacity: 0,
                showsURLInput: false
            )
        case .reverseSCurlAndInput:
            let inputProgress = min(max((eased - 0.62) / 0.38, 0), 1)
            return NozzleURLAnimationFrame(
                stage: keyframe.stage,
                stageProgress: progress,
                translation: CGPoint(
                    x: 112 + 74 * eased,
                    y: 18 + sin(eased * .pi * 2) * 13
                ),
                lift: 18,
                mouthRotation: .pi / 2,
                cCurl: 1,
                reverseSCurl: eased,
                inputOpacity: inputProgress,
                showsURLInput: inputProgress > 0
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
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 56))
        isHidden = true

        urlField.placeholderString = "Paste video link"
        urlField.setAccessibilityIdentifier("voice-vac-url-field")
        urlField.setAccessibilityLabel("Video URL")
        urlField.delegate = self
        urlField.isBezeled = false
        urlField.drawsBackground = false
        urlField.focusRingType = .none
        urlField.frame = CGRect(x: 16, y: 12, width: 234, height: 32)
        urlField.autoresizingMask = [.width]
        addSubview(urlField)

        startButton.bezelStyle = .texturedRounded
        startButton.setAccessibilityIdentifier("voice-vac-url-start")
        startButton.setAccessibilityLabel("Start URL transcription")
        startButton.target = self
        startButton.action = #selector(submitFromStartButton)
        startButton.frame = CGRect(x: 254, y: 12, width: 58, height: 32)
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
