#!/usr/bin/env python3
"""Persistent, offline Voice VAC Qwen3-ASR NDJSON worker."""

import base64
import binascii
import json
import os
import sys
import threading

from qwen_runtime import QwenRuntime, RuntimeFailure


STARTUP_MESSAGES = {
    "ASR_RUNTIME_MISSING": "Voice VAC local ASR runtime is not installed.",
    "ASR_MODEL_MISSING": "Voice VAC local Qwen3-ASR-0.6B model is not installed.",
    "ASR_MODEL_LOAD_FAILED": "Voice VAC could not load the local Qwen model.",
}


class ProtocolEmitter:
    def __init__(self, stdout):
        self._stdout = stdout
        self._lock = threading.Lock()

    def emit(self, payload):
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            self._stdout.write(encoded + "\n")
            self._stdout.flush()


def _reserve_protocol_stdout(stdout, stderr):
    """Keep a private copy of fd 1 and send every other stdout write to stderr.

    Model libraries can print from Python or native code. Redirecting the
    process fd (not merely ``sys.stdout``) keeps those diagnostics away from
    the machine-readable protocol while the emitter writes through the saved
    descriptor.
    """
    if stdout is not sys.stdout or stderr is not sys.stderr:
        return stdout
    stdout.flush()
    stderr.flush()
    protocol_fd = os.dup(stdout.fileno())
    protocol_stdout = os.fdopen(
        protocol_fd,
        mode="w",
        buffering=1,
        encoding=getattr(stdout, "encoding", None) or "utf-8",
    )
    os.dup2(stderr.fileno(), stdout.fileno())
    return protocol_stdout


def _default_runtime_factory():
    return QwenRuntime.from_local_path(os.environ.get("VOICE_VAC_QWEN_MODEL_PATH", ""))


def _decode_request(request):
    if not isinstance(request, dict):
        raise ValueError("request must be an object")
    request_id = request.get("id")
    if not isinstance(request_id, str) or not request_id:
        raise ValueError("request id must be a non-empty string")
    language = request.get("language")
    if language is not None and (not isinstance(language, str) or not language):
        raise ValueError("language must be null or a non-empty string")

    if "pcm" in request:
        allowed = {"id", "pcm", "sampleRate", "channels", "language"}
        if set(request) - allowed or set(request) < {"id", "pcm", "sampleRate", "channels"}:
            raise ValueError("invalid PCM request keys")
        if (
            type(request["sampleRate"]) is not int
            or type(request["channels"]) is not int
            or request["sampleRate"] != 16000
            or request["channels"] != 1
        ):
            raise ValueError("Voice VAC requires 16 kHz mono PCM")
        if not isinstance(request["pcm"], str):
            raise ValueError("pcm must be base64 text")
        pcm = base64.b64decode(request["pcm"], validate=True)
        if not pcm or len(pcm) % 2:
            raise ValueError("pcm must contain complete signed 16-bit samples")
        return request_id, "pcm", pcm, language

    if "audioPath" in request:
        allowed = {"id", "audioPath", "language"}
        if set(request) - allowed or set(request) < {"id", "audioPath"}:
            raise ValueError("invalid file request keys")
        if not isinstance(request["audioPath"], str) or not request["audioPath"]:
            raise ValueError("audioPath must be a non-empty string")
        return request_id, "file", request["audioPath"], language

    raise ValueError("request must contain pcm or audioPath")


def run_worker(*, runtime_factory=None, stdin=None, stdout=None, stderr=None):
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    stderr = stderr or sys.stderr
    emitter = ProtocolEmitter(_reserve_protocol_stdout(stdout, stderr))
    emitter.emit({"type": "status", "status": "booting"})
    emitter.emit({"type": "status", "status": "model_loading"})

    try:
        runtime = (runtime_factory or _default_runtime_factory)()
    except RuntimeFailure as error:
        stderr.write("Voice VAC ASR startup failed [{}]: {}\n".format(error.code, error))
        stderr.flush()
        code = error.code if error.code in STARTUP_MESSAGES else "ASR_MODEL_LOAD_FAILED"
        emitter.emit({
            "type": "fatal",
            "code": code,
            "error": STARTUP_MESSAGES[code],
            "retryable": False,
        })
        return 1
    except Exception as error:
        stderr.write("Voice VAC ASR startup failed: {}\n".format(error))
        stderr.flush()
        emitter.emit({
            "type": "fatal",
            "code": "ASR_MODEL_LOAD_FAILED",
            "error": STARTUP_MESSAGES["ASR_MODEL_LOAD_FAILED"],
            "retryable": False,
        })
        return 1

    emitter.emit({
        "type": "ready",
        "model_id": runtime.model_id,
        "device": runtime.device,
    })

    for line in stdin:
        if not line.strip():
            continue
        request_id = None
        try:
            request = json.loads(line)
            if isinstance(request, dict) and isinstance(request.get("id"), str):
                request_id = request["id"]
            if request_id:
                emitter.emit({"type": "accepted", "id": request_id})
            request_id, input_kind, payload, language = _decode_request(request)
            if input_kind == "pcm":
                result = runtime.transcribe_pcm(payload, sample_rate=16000, language=language)
            else:
                result = runtime.transcribe_file(payload, language=language)
            emitter.emit({
                "type": "result",
                "id": request_id,
                "text": result["text"],
                "language": result.get("language"),
            })
        except (RuntimeFailure, ValueError, TypeError, KeyError, json.JSONDecodeError, binascii.Error) as error:
            stderr.write("Voice VAC ASR request {} failed: {}\n".format(request_id or "<unknown>", error))
            stderr.flush()
            emitter.emit({
                "type": "error",
                "id": request_id,
                "code": "ASR_INFERENCE_FAILED",
                "error": "Voice VAC local ASR inference failed.",
                "retryable": True,
            })
        except Exception as error:
            stderr.write("Voice VAC ASR request {} failed: {}\n".format(request_id or "<unknown>", error))
            stderr.flush()
            emitter.emit({
                "type": "error",
                "id": request_id,
                "code": "ASR_INFERENCE_FAILED",
                "error": "Voice VAC local ASR inference failed.",
                "retryable": True,
            })
    return 0


if __name__ == "__main__":
    raise SystemExit(run_worker())
