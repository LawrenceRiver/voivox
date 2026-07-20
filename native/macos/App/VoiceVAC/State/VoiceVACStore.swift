import Observation
import VoiceVACCore

@MainActor
@Observable
final class VoiceVACStore {
    private(set) var state: VoiceVACState

    init(state: VoiceVACState = .idle) {
        self.state = state
    }

    @discardableResult
    func send(_ action: VoiceVACAction) -> [VoiceVACEffect] {
        let transition = VoiceVACReducer.reduce(state: state, action: action)
        state = transition.state
        return transition.effects
    }

    /// Native-only presentation failures (for example, no armed Chrome session)
    /// must not invent a cross-window attempt UUID merely to enter warning state.
    func reportLocalFailure(_ failure: VoiceVACFailure) {
        state.phase = .warningYellow
        state.failure = failure
        state.attemptID = nil
    }
}
