#!/usr/bin/env python3
"""Offline Qwen3-ASR runtime used by the persistent Voice VAC worker."""

import datetime
import hashlib
import importlib.metadata
import json
import os
import platform
from pathlib import Path


# These must exist before qwen-asr / transformers are imported. Runtime model
# loading is deliberately local-only; installation is a separate explicit step.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"


MODEL_ID = "Qwen/Qwen3-ASR-0.6B"
MODEL_REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"
RUNTIME_PACKAGE = "qwen-asr"
RUNTIME_VERSION = "0.0.6"


class RuntimeFailure(Exception):
    """A startup/inference failure with a stable cross-process code."""

    def __init__(self, code, message, cause=None):
        super().__init__(message)
        self.code = code
        self.cause = cause


def _load_dependencies():
    try:
        import qwen_asr
        import numpy
        import torch
        from qwen_asr import Qwen3ASRModel
    except (ImportError, ModuleNotFoundError) as error:
        raise RuntimeFailure(
            "ASR_RUNTIME_MISSING",
            "The pinned Voice VAC Qwen runtime is not installed.",
            error,
        ) from error
    try:
        runtime_version = importlib.metadata.version(RUNTIME_PACKAGE)
    except importlib.metadata.PackageNotFoundError:
        runtime_version = getattr(qwen_asr, "__version__", None)
    if runtime_version != RUNTIME_VERSION:
        raise RuntimeFailure(
            "ASR_RUNTIME_MISSING",
            "The pinned Voice VAC Qwen runtime version is not installed.",
        )
    return Qwen3ASRModel, torch, numpy, runtime_version


class QwenRuntime:
    """Thin adapter around the official qwen-asr Transformers backend."""

    def __init__(self, model, device, numpy_module, model_path, runtime_version):
        self._model = model
        self._numpy = numpy_module
        self.device = device
        self.model_id = MODEL_ID
        self.model_revision = MODEL_REVISION
        self.model_path = model_path
        self.python_version = platform.python_version()
        self.runtime_package = RUNTIME_PACKAGE
        self.runtime_version = runtime_version
        self.speech_api_used = False

    @classmethod
    def from_local_path(
        cls,
        model_path,
        *,
        dependency_loader=None,
        model_class=None,
        torch_module=None,
        numpy_module=None
    ):
        path = Path(model_path)
        if not path.is_absolute():
            raise RuntimeFailure(
                "ASR_MODEL_MISSING",
                "The pinned local Qwen3-ASR-0.6B model is not installed.",
            )
        path = path.resolve()
        if not _is_verified_model_install(path):
            raise RuntimeFailure(
                "ASR_MODEL_MISSING",
                "The pinned local Qwen3-ASR-0.6B model is not installed.",
            )

        if model_class is None or torch_module is None:
            loader = dependency_loader or _load_dependencies
            try:
                loaded_model_class, loaded_torch, loaded_numpy, loaded_runtime_version = loader()
            except RuntimeFailure:
                raise
            except (ImportError, ModuleNotFoundError) as error:
                raise RuntimeFailure(
                    "ASR_RUNTIME_MISSING",
                    "The pinned Voice VAC Qwen runtime is not installed.",
                    error,
                ) from error
            model_class = model_class or loaded_model_class
            torch_module = torch_module or loaded_torch
            numpy_module = numpy_module or loaded_numpy
            runtime_version = loaded_runtime_version
        elif numpy_module is None:
            try:
                import numpy as numpy_module
            except (ImportError, ModuleNotFoundError) as error:
                raise RuntimeFailure(
                    "ASR_RUNTIME_MISSING",
                    "The pinned Voice VAC Qwen runtime is not installed.",
                    error,
                ) from error
            runtime_version = RUNTIME_VERSION
        else:
            runtime_version = RUNTIME_VERSION

        attempts = []
        try:
            mps_available = bool(torch_module.backends.mps.is_available())
        except (AttributeError, RuntimeError):
            mps_available = False
        if mps_available:
            attempts.append(("mps", torch_module.float16))
        attempts.append(("cpu", torch_module.float32))

        last_error = None
        for device, dtype in attempts:
            try:
                model = model_class.from_pretrained(
                    str(path),
                    dtype=dtype,
                    device_map=device,
                    max_inference_batch_size=1,
                    max_new_tokens=256,
                )
                return cls(model, device, numpy_module, str(path), runtime_version)
            except Exception as error:  # the official stack exposes many loader errors
                last_error = error

        raise RuntimeFailure(
            "ASR_MODEL_LOAD_FAILED",
            "Voice VAC could not load the pinned local Qwen model.",
            last_error,
        ) from last_error

    def transcribe_pcm(self, pcm, *, sample_rate, language):
        if sample_rate != 16000 or not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
            raise RuntimeFailure(
                "ASR_INFERENCE_FAILED",
                "Voice VAC received invalid PCM16 audio.",
            )
        samples = self._numpy.frombuffer(pcm, dtype="<i2").astype(self._numpy.float32) / 32768.0
        return self._transcribe(audio=(samples, 16000), language=language)

    def transcribe_file(self, audio_path, *, language):
        path = Path(audio_path)
        if not path.is_absolute() or not path.is_file():
            raise RuntimeFailure(
                "ASR_INFERENCE_FAILED",
                "Voice VAC received an invalid local audio path.",
            )
        return self._transcribe(audio=str(path), language=language)

    def _transcribe(self, *, audio, language):
        try:
            results = self._model.transcribe(audio=audio, language=language)
            result = results[0]
            text = result.text
            detected_language = getattr(result, "language", None)
            if not isinstance(text, str):
                raise TypeError("qwen-asr returned non-string text")
            return {"text": text, "language": detected_language}
        except RuntimeFailure:
            raise
        except Exception as error:
            raise RuntimeFailure(
                "ASR_INFERENCE_FAILED",
                "Voice VAC local ASR inference failed.",
                error,
            ) from error


def _is_verified_model_install(path):
    config_path = path / "config.json"
    manifest_path = path / "model-manifest.json"
    if not path.is_dir() or not config_path.is_file() or not manifest_path.is_file():
        return False
    try:
        config = json.loads(config_path.read_text(encoding="utf-8"))
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        installed_at = manifest.get("installedAt")
        if not isinstance(config, dict) or not isinstance(manifest, dict):
            return False
        if not isinstance(installed_at, str):
            return False
        datetime.datetime.fromisoformat(installed_at.replace("Z", "+00:00"))
        return (
            manifest.get("schemaVersion") == 1
            and manifest.get("repoId") == MODEL_ID
            and manifest.get("revision") == MODEL_REVISION
            and manifest.get("modelPath") == str(path)
            and isinstance(manifest.get("configSha256"), str)
            and manifest.get("configSha256") == hashlib.sha256(config_path.read_bytes()).hexdigest()
        )
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return False
