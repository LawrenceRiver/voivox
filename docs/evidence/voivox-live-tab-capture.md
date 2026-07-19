# Live Chrome tab-capture acceptance

Date: 2026-07-17 (Asia/Shanghai)

This is a user-visible acceptance run of the unpacked extension in the user's normal Chrome profile. It is separate from the deterministic media/model smoke evidence because `chrome.tabCapture` can only be started by a real extension invocation.

## Path exercised

1. Played Lawrence River's public Xiaohongshu music-video post.
2. Opened Voice Vac from Chrome's Extensions menu and selected **Quality**.
3. Started tab capture, leaving the browser tab's media track enabled while Voice Vac routed playback into a zero-gain audio graph.
4. Captured a short live segment and selected **Stop and transcribe**.
5. Loaded the pinned `onnx-community/whisper-base` q8 model from the browser cache and ran inference with bundled ONNX Runtime WASM.
6. Observed the completed raw transcript in the popup and captured [the result screenshot](../assets/voivox-live-tab-transcription.jpg).

No speech API, microphone dictation channel, keyboard hook, or system loopback driver was used.

## Bugs found by the live run

- Chrome Offscreen Documents expose only `chrome.runtime` from the extension API surface. Direct `chrome.storage.local` access crashed with `Cannot read properties of undefined (reading 'local')`. Capture state is now persisted through runtime messages owned by the service worker.
- Serializing those state messages behind the outer capture command deadlocked startup: the service worker waited for offscreen startup while offscreen waited for its state write. State reads/writes now bypass the capture-operation queue while user capture commands remain serialized.
- q8 Whisper on WebGPU produced invalid/repetitive decoder output on this Chrome/macOS environment. Compact q8 inference now uses single-thread WASM, greedy decoding, incomplete-sequence handling, a bounded output budget, and repeat suppression.

## Observed result and scope

The final noisy 20-second music-video segment completed with finite, readable raw text:

> (laughing) I'm not sure if it's too long or too stop where I am about. You can do that expression again. This is so painful.

This proves the real capture-to-text path and guards against the original crash, deadlock, and runaway repetition. It is not a word-error-rate benchmark: music, laughter, edits, and mixed-language speech are intentionally difficult for an approximately 80 MB Whisper base q8 model. Voice Vac preserves raw model output so a later Codex/LLM step can clean or summarize it without overwriting the source.
