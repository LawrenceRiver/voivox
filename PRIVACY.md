# VOIVOX privacy

VOIVOX is local-first. It does not require an account, an API key, a cloud speech service, or an external LLM.

## What stays on the device

- Tab audio is captured only after the user clicks the Chrome extension. It always stays in extension memory for browser-local transcription and is not written to an audio file.
- Browser-local speech recognition runs inside the extension with bundled JavaScript/WASM and cached open-weight model files.
- Experimental selected-App capture also records to a short-lived WAV in the macOS temporary directory. VOIVOX deletes that capture and its temporary directory after transcription or cleanup. The native audio helper also watches its dedicated parent pipe and tears down the Core Audio tap if the App crashes; a hard system/power failure can still leave temporary data for the operating system to clean up.
- The desktop App stores transcript sessions under the current macOS user's VOIVOX application-data directory.
- When the App is open, the extension may send the completed **text transcript** to the App so its local Codex MCP can read it. The restricted bridge has no Chrome audio endpoint, so browser audio cannot be sent during this sync.
- Desktop bridge credentials are local-only, owner-readable files. They are never exposed by MCP tools.

VOIVOX and its MCP do not upload audio to an LLM provider. If the user asks Codex to read or transform transcript text through MCP, that **text** may be processed by the model provider selected in Codex under that provider's terms and settings. This is a separate, user-initiated boundary from VOIVOX's local speech recognition.

## Network access

On first use of Fast or Quality mode, the extension downloads the selected pinned model revision from Hugging Face. That request necessarily exposes ordinary connection metadata such as the user's IP address to the model host. After Chrome caches the model, transcription itself runs locally. VOIVOX does not send captured audio or transcripts to Hugging Face.

The optional `scripts/install-asr-runtime.sh` command creates a Python environment and downloads `mlx-qwen3-asr` from Python package indexes. Its `Qwen/Qwen3-ASR-0.6B` weights download on the first desktop-ASR transcription. These downloads expose ordinary connection metadata to the relevant package/model hosts; selected audio and resulting text are not uploaded by VOIVOX.

The optional desktop App and Codex MCP communicate only through `127.0.0.1`. No VOIVOX service listens on a LAN or public-network interface.

## Retention and control

- The popup may be closed while capture or transcription continues in the extension's offscreen context.
- Cancelling local transcription, or a transcription watchdog timeout, keeps the full captured audio only in offscreen memory so the user can retry without recording again. That retry buffer is cleared after a successful result, when a new capture starts, when the extension is reloaded/updated, or when Chrome exits. It is never written to an audio file by the browser-local route.
- Reloading the extension or exiting Chrome can interrupt work and discard an in-memory capture or retry buffer.
- Completed extension state is stored in Chrome extension local storage until a later capture replaces it or the extension is removed.
- Desktop sessions remain in the user's VOIVOX application-data directory until the user removes that data.
- Downloaded browser models can be removed by clearing the extension's site/storage data or uninstalling the extension.

VOIVOX does not sell data, use analytics SDKs, or create advertising profiles.

## Permissions

- `activeTab` and `tabCapture`: capture only the tab selected by the user's direct click.
- `offscreen`: keep the user-approved tab audio graph and local ASR worker alive while the popup is closed.
- `storage`: preserve capture state, language, mode, and completed text locally.
- `nativeMessaging`: discover the optional VOIVOX App through an exact, signed local bridge.
- Hugging Face host access: download the pinned model files; audio and transcript text are not uploaded.

Security reports should follow [SECURITY.md](SECURITY.md).
