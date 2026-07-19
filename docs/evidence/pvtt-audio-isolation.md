# Voice Vac PVTT audio-isolation acceptance

Automated coverage verifies the isolation design: Chrome starts `tabCapture` only after a user gesture, routes the captured stream through a zero-gain Web Audio graph, and sends only the completed text to the optional App bridge. The App's macOS process path uses its existing dedicated Core Audio tap and does not replace the system output device.

The final manual check must be run on the target Mac with a rights-cleared local video fixture:

1. Start playback in one Chrome tab and keep another tab, Spotify, Logic Pro, and the microphone active but unrelated.
2. Drag the Voice Vac suction head to the target video and start capture.
3. Confirm only the target tab is muted and transcribed; the other tab and applications remain audible and absent from the transcript.
4. Stop, copy the transcript, then repeat with the App closed to verify the Extension remains standalone.

This manual acceptance is intentionally not represented as completed by automated tests because it depends on the host's Chrome permissions, audio graph, and physical playback environment.
