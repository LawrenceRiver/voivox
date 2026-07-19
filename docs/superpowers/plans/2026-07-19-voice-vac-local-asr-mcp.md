# Voice VAC Local Qwen ASR + MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make transcribe_active_video actively command the user-armed Chrome tab, stream only that tab's PCM into the desktop app, transcribe it with a genuinely loaded local Qwen3-ASR-0.6B model, and return incremental then terminal structured transcript data to MCP without any inference API.

**Architecture:** Chrome remains the only component allowed to invoke tabCapture and sends ordered PCM16 over the existing authenticated loopback bridge. Desktop owns a persistent Python worker, revisioned transcript stream, command/job coordinator, and local Qwen model. MCP creates a job and condition-waits for that job instead of reading an old completed session. A user-armed tunnel session is mandatory, so MCP never bypasses Chrome's user-gesture boundary.

**Tech Stack:** TypeScript, Node HTTP, Electron, Chrome MV3 tabCapture/Offscreen/Native Messaging, Python 3.12, qwen-asr==0.0.6, Qwen/Qwen3-ASR-0.6B, Vitest, unittest, Swift Testing, MCP TypeScript SDK.

## Global Constraints

- Inference is offline and local. Explicit installation may download weights; runtime sets HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1.
- Pin Qwen/Qwen3-ASR-0.6B snapshot 5eb144179a02acc5e5ba31e748d22b0cf3e303b0 below `Voice VAC/models/Qwen3-ASR-0.6B`, not in the app bundle.
- Preserve primary-token/MCP-proof versus restricted-extension-token/native-proof separation.
- Only the armed target tab may enter audio. Never request microphone, enumerate devices, alter macOS output, create a virtual device, or use audible gain.
- A ready tunnel records user intent but navigation, tab closure, expired activeTab, or denied tabCapture invalidate it.
- auto uses live tunnel in this phase. Explicit accelerated returns ACCELERATED_SOURCE_UNAVAILABLE.
- Do not stage unrelated dirty files. Each commit command names its task files only.

## Root-Cause Audit

| Boundary | Current defect | Required correction |
|---|---|---|
| Python | Imports nonexistent mlx_qwen3_asr.Session and has no readiness event | Official qwen-asr plus typed boot/ready/fatal NDJSON |
| Readiness | find_spec is called ready | ready only after model construction returns |
| Timeout | One timer includes boot, load, queue, inference | Separate startup inactivity/hard, accept, and inference timers |
| Extension | Always browser Whisper; desktop gets completed text only | Ordered PCM16 relay to desktop Qwen |
| Store | Whole snapshots, no revision wait | Monotonic deltas and race-safe condition waits |
| MCP | Returns latest prior transcript; generic 30-second timeout | Create job, relay command, await its revisions |

Official basis: the [Qwen3-ASR README](https://github.com/QwenLM/Qwen3-ASR/blob/main/README.md) specifies the qwen-asr Transformers backend, Python 3.12, local model download, and numpy/sample-rate input. Use the [official 0.6B model](https://huggingface.co/Qwen/Qwen3-ASR-0.6B). Do not use vLLM or FlashAttention on this macOS path; prefer MPS with CPU fallback.

---

### Task 1: Stable typed error contract

**Files**
- Create packages/core/src/voice-vac-error.ts
- Create packages/core/tests/voice-vac-error.test.ts
- Modify packages/core/src/index.ts
- Modify packages/core/src/loopback-server.ts

- [ ] RED: Test exact JSON {code,error,retryable}, fixed HTTP status, cause preservation, and stack/stdout/stderr redaction for NEEDS_USER_ARMING, TAB_NOT_ARMED, TARGET_NAVIGATED, TAB_CLOSED, CAPTURE_DENIED, STREAM_ID_EXPIRED, STREAM_ENDED, NATIVE_HOST_UNAVAILABLE, EXTENSION_UNAVAILABLE, COMMAND_ACK_TIMEOUT, ASR_RUNTIME_MISSING, ASR_MODEL_MISSING, ASR_MODEL_LOAD_FAILED, ASR_STARTUP_TIMEOUT, ASR_INFERENCE_TIMEOUT, ASR_INFERENCE_FAILED, AUDIO_SEQUENCE_MISMATCH, AUDIO_RELAY_BACKPRESSURE, NO_AUDIO_AFTER_TIMEOUT, TRANSCRIPTION_CANCELLED, TRANSCRIPTION_DEADLINE_EXCEEDED, and ACCELERATED_SOURCE_UNAVAILABLE.
- [ ] Run: npx vitest run packages/core/tests/voice-vac-error.test.ts. Expected: missing module.
- [ ] Implement one readonly code tuple, VoiceVacError(code,message,retryable,httpStatus,cause), isVoiceVacError, and safe HTTP serializer. Unknown errors become generic 500, never generic 400 with internals.
- [ ] GREEN: npx vitest run packages/core/tests/voice-vac-error.test.ts packages/core/tests/loopback-server.test.ts && npm run typecheck.
- [ ] Commit:
  git add packages/core/src/voice-vac-error.ts packages/core/src/index.ts packages/core/src/loopback-server.ts packages/core/tests/voice-vac-error.test.ts packages/core/tests/loopback-server.test.ts
  git commit -m "feat(core): add stable Voice VAC error contract"

---

### Task 2: Real offline Qwen Python worker

**Files**
- Create native/asr/qwen_runtime.py
- Create native/asr/tests/test_qwen_runtime.py
- Create native/asr/tests/test_voivox_asr_worker.py
- Modify native/asr/voivox_asr_worker.py

- [ ] RED with an injected fake loader/runtime; unit tests must not load model weights. Assert ordered frames: status/booting, status/model_loading, ready(model_id,device), accepted(id), result(id,text,language).
- [ ] RED also covers malformed base64 -> ASR_INFERENCE_FAILED; missing package -> one fatal ASR_RUNTIME_MISSING and exit; missing config.json -> ASR_MODEL_MISSING; construction failure -> ASR_MODEL_LOAD_FAILED; little-endian signed PCM16 converts to float32 without a temporary WAV.
- [ ] Run: python3 -m unittest discover -s native/asr/tests -p 'test_*.py' -v. Expected: current mlx adapter fails.
- [ ] Implement QwenRuntime.from_local_path. Set offline flags before imports. Require absolute local model path and config.json. Try MPS with torch.float16, then CPU with torch.float32. Call Qwen3ASRModel.from_pretrained(path, device_map=device, max_inference_batch_size=1, max_new_tokens=256).
- [ ] Decode PCM using numpy.frombuffer(pcm,dtype='<i2').astype(float32)/32768 and call model.transcribe(audio=(samples,16000), language=None-or-explicit)[0].
- [ ] Worker transport validates exact request keys, sampleRate=16000, channels=1; stdout contains protocol only, stderr diagnostics only, and stdout emission is locked.
- [ ] GREEN: python3 -m unittest discover -s native/asr/tests -p 'test_*.py' -v && python3 -m py_compile native/asr/qwen_runtime.py native/asr/voivox_asr_worker.py.
- [ ] Commit:
  git add native/asr/qwen_runtime.py native/asr/voivox_asr_worker.py native/asr/tests
  git commit -m "feat(asr): load official local Qwen3 ASR worker"

---

### Task 3: Actual readiness and phase-owned timeouts

**Files**
- Create apps/desktop/tests/fixtures/protocol-asr-worker.cjs
- Modify apps/desktop/src/main/python-qwen-asr-engine.ts
- Modify apps/desktop/tests/python-qwen-asr-engine.test.ts
- Modify apps/desktop/src/main/local-asr-capability.ts
- Modify apps/desktop/tests/local-asr-capability.test.ts

- [ ] RED: start remains pending across boot/model_loading and resolves only on ready; no request is written before ready; startup activity resets inactivity but not hard deadline; accept timer begins after write; inference timer begins after accepted; concurrent calls serialize; fatal code survives; malformed frames terminate; capability never uses find_spec.
- [ ] Run: npx vitest run apps/desktop/tests/python-qwen-asr-engine.test.ts apps/desktop/tests/local-asr-capability.test.ts.
- [ ] Implement public start(), getStatus(), transcribe(), transcribeFile(), close(). Use one startPromise and serial request tail.
- [ ] Defaults: startup inactivity 90s, startup hard deadline 20m, accept 5s, inference 30m, SIGTERM grace 2s. Status resets only startup inactivity. Queue wait owns no inference timer.
- [ ] Spawn env includes VOICE_VAC_QWEN_MODEL_PATH, HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1. Keep bounded SIGTERM-to-SIGKILL close.
- [ ] Capability remains checking until this exact engine emits ready; fatal becomes missing. Delete find_spec logic.
- [ ] GREEN: targeted Vitest above plus npm run typecheck.
- [ ] Commit:
  git add apps/desktop/src/main/python-qwen-asr-engine.ts apps/desktop/src/main/local-asr-capability.ts apps/desktop/tests/python-qwen-asr-engine.test.ts apps/desktop/tests/local-asr-capability.test.ts apps/desktop/tests/fixtures/protocol-asr-worker.cjs
  git commit -m "fix(desktop): wait for actual Qwen model readiness"

---

### Task 4: Reproducible external runtime/model install

**Files**
- Create native/asr/requirements.txt
- Create scripts/download-qwen-model.py
- Modify scripts/install-asr-runtime.sh
- Modify apps/desktop/src/main/python-runtime.ts
- Modify apps/desktop/tests/python-runtime.test.ts
- Modify apps/desktop/package.json
- Modify apps/desktop/tests/desktop-build-artifacts.test.ts
- Modify scripts/verify-local-asr.mjs
- Modify scripts/verify-local-asr-lib.mjs
- Modify scripts/verify-local-asr.test.mjs

- [ ] RED: assert Python 3.12, qwen-asr==0.0.6, pinned snapshot, external model dir, offline env, both Python files packaged, Qwen model in verification, no Whisper IDs.
- [ ] Run targeted Vitest and node --test scripts/verify-local-asr.test.mjs; expect current Whisper/mlx assertions to fail.
- [ ] requirements.txt contains qwen-asr==0.0.6. Installer creates asr-venv and invokes huggingface_hub.snapshot_download(repo_id='Qwen/Qwen3-ASR-0.6B', revision=pinned_hash, local_dir=model_dir).
- [ ] Atomically write model-manifest.json containing repo, revision, path, install time. Startup refuses missing manifest/config rather than first-use download.
- [ ] Verification extracts 16k mono with FFmpeg, runs the same worker, waits ready, submits audio, and records device, load/inference/total seconds, hashes, model revision, text, and speechApiUsed:false.
- [ ] Build copies qwen_runtime.py and voivox_asr_worker.py; model/venv remain external.
- [ ] GREEN: targeted tests, bash -n scripts/install-asr-runtime.sh, npm run typecheck.
- [ ] Commit:
  git add native/asr/requirements.txt scripts/download-qwen-model.py scripts/install-asr-runtime.sh scripts/verify-local-asr.mjs scripts/verify-local-asr-lib.mjs scripts/verify-local-asr.test.mjs apps/desktop/src/main/python-runtime.ts apps/desktop/tests/python-runtime.test.ts apps/desktop/package.json apps/desktop/tests/desktop-build-artifacts.test.ts
  git commit -m "build(asr): pin local Qwen runtime and model install"

---

### Task 5: Revisioned incremental transcript stream

**Files**
- Create packages/core/src/transcript-events.ts
- Create packages/core/tests/transcript-events.test.ts
- Modify packages/core/src/voivox-service.ts
- Modify packages/core/tests/voivox-service.test.ts
- Modify packages/core/src/json-session-store.ts
- Modify packages/core/tests/json-session-store.test.ts
- Modify apps/desktop/src/main/asr-pipeline.ts
- Modify apps/desktop/tests/asr-pipeline.test.ts

- [ ] RED: every append/completion/failure/cancel increments revision once; changesSince returns only new segments plus latest status; waitForChange cannot miss check/register race, accepts AbortSignal, and returns undefined only on long-poll ceiling; recovery seeds coherent snapshot; two windows publish before stop.
- [ ] Run targeted Vitest; expect missing revision/event APIs.
- [ ] Add CaptureSession.revision; statuses failed/cancelled; failure {code,message,retryable}; VoivoxService.failCapture/cancelCapture.
- [ ] Implement TranscriptDelta {sessionId,afterRevision,revision,status,appendedSegments,failure?}, changesSince, and waitForChange(sessionId,afterRevision,{signal,waitMs}). Keep bounded live journal and atomic current-session persistence.
- [ ] Validate nonempty, ordered, nonoverlapping segments before publishing.
- [ ] BufferedAsrPipeline uses per-session 4s fast or 8s quality windows. It must not swallow engine errors: publish failed and make finish reject.
- [ ] GREEN: targeted Vitest plus npm run typecheck.
- [ ] Commit:
  git add packages/core/src/transcript-events.ts packages/core/src/voivox-service.ts packages/core/src/json-session-store.ts packages/core/tests/transcript-events.test.ts packages/core/tests/voivox-service.test.ts packages/core/tests/json-session-store.test.ts apps/desktop/src/main/asr-pipeline.ts apps/desktop/tests/asr-pipeline.test.ts
  git commit -m "feat(core): stream incremental transcript revisions"

---

### Task 6: Restricted extension-owned PCM ingestion

**Files**
- Create apps/desktop/src/main/extension-capture-controller.ts
- Create apps/desktop/tests/extension-capture-controller.test.ts
- Modify packages/core/src/loopback-server.ts
- Modify packages/core/tests/loopback-server.test.ts
- Modify apps/desktop/electron/main.ts

- [ ] RED API: POST /v1/extension/captures; POST /v1/extension/captures/:id/audio/:sequence as octet-stream; GET transcript?after_revision=N&wait_ms=25000; POST stop.
- [ ] Assert only chrome-tab source; PCM is even and <=128KiB; sequence begins 0 and is exact; 204 unchanged wait; stop flushes Qwen before complete; zero audio errors; wrong origin/token/session cannot mutate desktop capture.
- [ ] Run targeted Vitest; expect current intentional 404 tests.
- [ ] ExtensionCaptureController owns session-to-job/tunnel binding, sequence and received byte count; only it calls BufferedAsrPipeline.ingest for extension bytes.
- [ ] Remove completed-text /v1/extension/transcripts production route. Preserve exact-origin CORS, proof, body limits, and least privilege.
- [ ] Wire one controller/pipeline/service/engine in Electron main; async-start engine readiness using real local model path.
- [ ] GREEN: targeted Vitest plus npm run typecheck.
- [ ] Commit:
  git add apps/desktop/src/main/extension-capture-controller.ts apps/desktop/tests/extension-capture-controller.test.ts apps/desktop/electron/main.ts packages/core/src/loopback-server.ts packages/core/tests/loopback-server.test.ts
  git commit -m "feat(desktop): ingest isolated Chrome PCM into local ASR"

---

### Task 7: Backpressured Extension desktop relay

**Files**
- Create apps/chrome-extension/src/desktop-audio-relay.ts
- Create apps/chrome-extension/tests/desktop-audio-relay.test.ts
- Modify apps/chrome-extension/src/audio-codec.ts
- Modify apps/chrome-extension/tests/audio-codec.test.ts
- Modify apps/chrome-extension/src/local-transcription.ts
- Modify apps/chrome-extension/tests/local-transcription.test.ts
- Modify apps/chrome-extension/src/offscreen.ts
- Modify apps/chrome-extension/tests/offscreen-reliability.test.ts
- Modify apps/chrome-extension/src/bridge.ts
- Modify apps/chrome-extension/package.json
- Modify apps/chrome-extension/public/manifest.json
- Modify apps/chrome-extension/tests/extension-build-artifacts.test.ts

- [ ] RED: Float32 clipping to PCM16; consecutive one-second 32000-byte chunks; sequential HTTP; stop drains; revision poll merges; queue depth five allowed/sixth AUDIO_RELAY_BACKPRESSURE.
- [ ] Assert Offscreen getUserMedia uses only chromeMediaSource tab/id, gain is zero, and no browser ASR Worker is constructed.
- [ ] Run targeted extension tests.
- [ ] Route is desktop-local or unavailable. Verified native checking/ready may use desktop; missing cannot. Acquire tab MediaStream immediately before bridge setup to avoid stream ID expiry.
- [ ] DesktopAudioRelay creates session, encodes/enqueues ordered chunks, long-polls deltas, drains/stops on track end, and maps stable codes to CaptureState.
- [ ] Remove asr-worker build, Transformers/WASM copies, HF host permissions, Whisper IDs and download-size UI claims.
- [ ] GREEN: npx vitest run apps/chrome-extension/tests && npm run typecheck && npm run build --workspace=@voivox/chrome-extension.
- [ ] Commit:
  git add apps/chrome-extension/src apps/chrome-extension/tests apps/chrome-extension/package.json apps/chrome-extension/public/manifest.json
  git commit -m "feat(extension): relay isolated tab PCM to desktop Qwen"

---

### Task 8: Idempotent desktop-to-extension command relay

**Files**
- Create packages/core/src/extension-command-relay.ts
- Create packages/core/tests/extension-command-relay.test.ts
- Modify packages/core/src/cross-window-session.ts
- Modify packages/core/tests/cross-window-session.test.ts
- Modify packages/core/src/loopback-server.ts
- Modify packages/core/tests/loopback-server.test.ts
- Create apps/chrome-extension/src/native-command-relay.ts
- Create apps/chrome-extension/tests/native-command-relay.test.ts
- Modify apps/chrome-extension/src/service-worker.ts
- Modify apps/chrome-extension/tests/service-worker-reliability.test.ts

- [ ] RED: newest ready tunnel targeted; none -> NEEDS_USER_ARMING; command leased until ACK; expired lease redelivers; ACK/command ID idempotent; cursor persists only after ACK.
- [ ] RED: connectNative remains long-lived, reconnect is bounded, only one port/timer/poll exists.
- [ ] Implement GET /v1/extension/commands/next?after_sequence=N&wait_ms=25000 and POST /v1/extension/commands/:id/ack.
- [ ] Command is {id,sequence,type:'START_ACTIVE_VIDEO',jobId,tunnelSessionId,tabId,expectedUrl,options}; ACK is accepted/rejected with code and optional captureSessionId.
- [ ] Refactor startCapture(tabId). chrome.tabs.get must match expectedUrl before tabCapture. Map closure/navigation/permission/expiry to stable codes. jobId prevents duplicate capture.
- [ ] connectNative sends strict discover; authenticated HTTP carries commands. Reconnect 250ms,500ms,1s,2s,4s, then max 10s.
- [ ] GREEN: targeted core/extension tests plus typecheck.
- [ ] Commit:
  git add packages/core/src/extension-command-relay.ts packages/core/src/cross-window-session.ts packages/core/src/loopback-server.ts packages/core/tests/extension-command-relay.test.ts packages/core/tests/cross-window-session.test.ts packages/core/tests/loopback-server.test.ts apps/chrome-extension/src/native-command-relay.ts apps/chrome-extension/src/service-worker.ts apps/chrome-extension/tests/native-command-relay.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts
  git commit -m "feat(bridge): relay active-video commands to armed Chrome tab"

---

### Task 9: Active-video job coordinator

**Files**
- Create packages/core/src/transcription-jobs.ts
- Create packages/core/tests/transcription-jobs.test.ts
- Create apps/desktop/src/main/active-video-coordinator.ts
- Create apps/desktop/tests/active-video-coordinator.test.ts
- Modify packages/core/src/loopback-server.ts
- Modify packages/core/tests/loopback-server.test.ts
- Modify apps/desktop/electron/main.ts

- [ ] RED lifecycle: queued -> waiting_for_extension -> capturing -> transcribing -> completed, plus every terminal error. Bind exactly one command, tunnel, capture and revision; ignore prior completed transcript; cancellation aborts once.
- [ ] Implement POST /v1/transcriptions/active-video -> 202 job; GET job; GET job/wait?after_revision=N&wait_ms=25000; POST job/cancel.
- [ ] Long-poll ceiling is not deadline. Coordinator uses two-hour overall deadline and two-minute no-progress deadline after capture starts; model-loading status counts as pre-capture progress.
- [ ] Coordinator checks runtime, selects newest ready tunnel, rejects explicit accelerated, enqueues/awaits ACK, follows that capture's deltas, and builds createTranscriptResult only from it.
- [ ] Preserve URL/title/language/duration/ordered segments and processing_mode live_tunnel. Delete fallback to getLatestBrowserTranscript.
- [ ] Wire stores, relay, controller, events, engine in Electron composition root.
- [ ] GREEN: targeted tests plus typecheck.
- [ ] Commit:
  git add packages/core/src/transcription-jobs.ts packages/core/src/loopback-server.ts packages/core/tests/transcription-jobs.test.ts packages/core/tests/loopback-server.test.ts apps/desktop/src/main/active-video-coordinator.ts apps/desktop/tests/active-video-coordinator.test.ts apps/desktop/electron/main.ts
  git commit -m "feat(desktop): coordinate active-video transcription jobs"

---

### Task 10: MCP triggers and waits for its job

**Files**
- Modify apps/mcp/src/voivox-client.ts
- Modify apps/mcp/tests/voivox-client.test.ts
- Modify apps/mcp/src/index.ts
- Modify apps/mcp/tests/mcp-server.test.ts

- [ ] RED E2E: do not pre-import text. Call MCP, observe command, ACK, create capture, append two revisions, complete, assert exact new structured transcript. Cover arming/model/command/cancel/deadline structured errors.
- [ ] VoivoxClient POSTs once, then condition-waits job revisions. Ordinary/proof requests remain 30s; each long poll is 30s; overall transcription is independently configurable two hours. Never retry POST after job ID.
- [ ] Validate completed body with validateTranscriptResult. Typed failure becomes VoivoxRequestError and MCP {error:{code,message}}, without stack/token/audio/stderr.
- [ ] Keep get_latest_transcript separate/read-only; describe user arming prerequisite.
- [ ] GREEN: targeted MCP tests, typecheck, MCP build.
- [ ] Commit:
  git add apps/mcp/src/voivox-client.ts apps/mcp/src/index.ts apps/mcp/tests/voivox-client.test.ts apps/mcp/tests/mcp-server.test.ts
  git commit -m "feat(mcp): trigger and await active Chrome transcription"

---

### Task 11: Isolation, authorization, and lifecycle regression

**Files**
- Create apps/chrome-extension/tests/audio-isolation.test.ts
- Modify apps/chrome-extension/tests/offscreen-reliability.test.ts
- Modify apps/chrome-extension/tests/service-worker-reliability.test.ts
- Modify packages/core/tests/loopback-server.test.ts
- Modify apps/desktop/tests/shutdown-order.test.ts
- Modify native/macos/Tests/VOIVOXNativeHostTests/NativeHostProtocolTests.swift

- [ ] Tests prove only target-tab constraints/source, zero gain forever, no mic/device/system-output APIs, no other app/tab route.
- [ ] Extension token cannot use MCP jobs, desktop captures/process list/foreign session. MCP token cannot ACK or upload extension audio.
- [ ] Native host serves consecutive requests but reveals only restricted connection. Reconnect does not leak processes.
- [ ] Shutdown cancels jobs/waits, stops capture, closes Qwen, invalidates connection files, then quits.
- [ ] Add source guard against getDisplayMedia, enumerateDevices, deviceId, microphone constraints, HF hosts, Whisper IDs, or nonzero gain.
- [ ] Run targeted Vitest and swift test --package-path native/macos.
- [ ] Commit:
  git add apps/chrome-extension/tests/audio-isolation.test.ts apps/chrome-extension/tests/offscreen-reliability.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts packages/core/tests/loopback-server.test.ts apps/desktop/tests/shutdown-order.test.ts native/macos/Tests/VOIVOXNativeHostTests/NativeHostProtocolTests.swift
  git commit -m "test(security): lock private tab-audio isolation"

---

### Task 12: Real no-API smoke, packaging, evidence

**Files**
- Create docs/testing/local-qwen-mcp-smoke.md
- Create docs/testing/fixtures/README.md
- Modify README.md
- Modify docs/testing/REAL_DEVICE_TEST_PLAN.md
- Modify scripts/verify-local-asr.mjs

- [ ] Preflight reports Python/package/model manifest and revision/model size/device/FFmpeg/Chrome/CPU/GPU/memory/network state; model mismatch stops.
- [ ] Gate: npm test; npm run typecheck; swift test --package-path native/macos; Python unittest; npm run build.
- [ ] On user-owned non-DRM 60s Chinese/English video: record macOS and Logic devices; wait true ready; arm target; keep second tab and Spotify audible; call MCP without another Start; see incremental text; validate final structured result.
- [ ] Confirm target silent, second tab/Spotify audible, no mic permission, devices unchanged. Navigation returns TARGET_NAVIGATED; re-arm succeeds. Disable network and repeat.
- [ ] Save redacted evidence under docs/testing/evidence/local-qwen-mcp: health, MCP result, revision timeline, model manifest, environment, RTF, screenshots. Never store tokens/raw audio/private URLs/cookies/personal paths.
- [ ] README claims only local Qwen 0.6B, target-tab live tunnel, user arming, no inference API, explicit install, auto-to-live, accelerated separate. No universal speed claim.
- [ ] Commit:
  git add README.md docs/testing scripts/verify-local-asr.mjs
  git commit -m "docs: verify local Qwen MCP transcription end to end"

## Final Self-Review Gate

- [ ] Every active-video success is newer than its POST; no test substitutes getLatestBrowserTranscript.
- [ ] ready occurs only after Qwen3ASRModel.from_pretrained returns.
- [ ] Startup inactivity/hard, accept, inference, long-poll, no-progress, and overall deadlines each have an owner/test.
- [ ] Runtime succeeds offline; extension HF/Whisper artifacts and permissions are absent.
- [ ] User arming is enforced and navigation invalidates it.
- [ ] Revision waits are race-safe and condition-driven; no correctness sleep.
- [ ] Tokens remain least-privilege and both proofs pass.
- [ ] No microphone/system-output/virtual-device/other-tab/app route exists.
- [ ] Every terminal path has a stable nonempty code.
- [ ] npm test, typecheck, Python tests, Swift tests, and builds pass clean.
- [ ] Placeholder audit prints nothing:
  rg -n '\b([T]ODO|[T]BD|[F]IXME|[P]LACEHOLDER)\b|\x3c[^\x3e]+\x3e' docs/superpowers/plans/2026-07-19-voice-vac-local-asr-mcp.md
