import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ASR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASR_ROOT))

from qwen_runtime import RuntimeFailure  # noqa: E402
from voivox_asr_worker import run_worker  # noqa: E402


class FakeRuntime:
    model_id = "Qwen/Qwen3-ASR-0.6B"
    model_revision = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"
    device = "mps"
    python_version = "3.12.9"
    runtime_package = "qwen-asr"
    runtime_version = "0.0.6"
    speech_api_used = False

    def __init__(self):
        self.calls = []

    def transcribe_pcm(self, pcm, *, sample_rate, language):
        self.calls.append((pcm, sample_rate, language))
        return {"text": "hello from Voice VAC", "language": "English"}


def parse_lines(stream):
    return [json.loads(line) for line in stream.getvalue().splitlines()]


class WorkerProtocolTests(unittest.TestCase):
    def run_protocol(self, lines, factory=None):
        runtime = FakeRuntime()
        stdout = io.StringIO()
        stderr = io.StringIO()
        exit_code = run_worker(
            runtime_factory=factory or (lambda: runtime),
            stdin=io.StringIO("".join(json.dumps(line) + "\n" for line in lines)),
            stdout=stdout,
            stderr=stderr,
        )
        return runtime, exit_code, parse_lines(stdout), stderr.getvalue()

    def test_emits_ordered_boot_ready_accept_and_result_frames(self):
        pcm = b"\x00\x00\xff\x7f"
        runtime, exit_code, frames, stderr = self.run_protocol(
            [{"id": "asr_1", "pcm": base64.b64encode(pcm).decode(), "sampleRate": 16000, "channels": 1, "language": None}]
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(stderr, "")
        self.assertEqual(
            frames,
            [
                {"type": "status", "status": "booting"},
                {"type": "status", "status": "model_loading"},
                {
                    "type": "ready",
                    "model_id": "Qwen/Qwen3-ASR-0.6B",
                    "model_revision": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
                    "device": "mps",
                    "python_version": "3.12.9",
                    "runtime_package": "qwen-asr",
                    "runtime_version": "0.0.6",
                    "speech_api_used": False,
                    "offline": True,
                },
                {"type": "accepted", "id": "asr_1"},
                {"type": "result", "id": "asr_1", "text": "hello from Voice VAC", "language": "English"},
            ],
        )
        self.assertEqual(runtime.calls, [(pcm, 16000, None)])

    def test_malformed_base64_and_extra_keys_become_typed_inference_errors(self):
        _, exit_code, frames, _ = self.run_protocol(
            [
                {"id": "bad_1", "pcm": "%%%", "sampleRate": 16000, "channels": 1},
                {"id": "bad_2", "pcm": "AA==", "sampleRate": 16000, "channels": 1, "extra": True},
            ]
        )

        self.assertEqual(exit_code, 0)
        self.assertEqual(frames[3], {"type": "accepted", "id": "bad_1"})
        self.assertEqual(frames[4]["type"], "error")
        self.assertEqual(frames[4]["code"], "ASR_INFERENCE_FAILED")
        self.assertNotIn("%%%", frames[4]["error"])
        self.assertEqual(frames[5], {"type": "accepted", "id": "bad_2"})
        self.assertEqual(frames[6]["code"], "ASR_INFERENCE_FAILED")

    def test_wrong_sample_rate_or_channels_are_rejected_without_calling_runtime(self):
        runtime, _, frames, _ = self.run_protocol(
            [
                {"id": "bad_rate", "pcm": "AAA=", "sampleRate": 44100, "channels": 1},
                {"id": "bad_channels", "pcm": "AAA=", "sampleRate": 16000, "channels": 2},
                {"id": "float_rate", "pcm": "AAA=", "sampleRate": 16000.0, "channels": 1},
                {"id": "bool_channels", "pcm": "AAA=", "sampleRate": 16000, "channels": True},
            ]
        )
        self.assertEqual(runtime.calls, [])
        self.assertEqual(
            [frame.get("code") for frame in frames if frame["type"] == "error"],
            ["ASR_INFERENCE_FAILED"] * 4,
        )

    def test_worker_never_materializes_pcm_as_a_temporary_wav(self):
        source = (ASR_ROOT / "voivox_asr_worker.py").read_text(encoding="utf-8")
        self.assertNotIn("tempfile", source)
        self.assertNotIn("wave.open", source)

    def test_startup_failure_emits_one_fatal_frame_and_exits(self):
        for code in ("ASR_RUNTIME_MISSING", "ASR_MODEL_MISSING", "ASR_MODEL_LOAD_FAILED"):
            with self.subTest(code=code):
                stdout = io.StringIO()
                stderr = io.StringIO()
                exit_code = run_worker(
                    runtime_factory=lambda code=code: (_ for _ in ()).throw(RuntimeFailure(code, "private diagnostic")),
                    stdin=io.StringIO(""),
                    stdout=stdout,
                    stderr=stderr,
                )
                frames = parse_lines(stdout)
                self.assertEqual(exit_code, 1)
                self.assertEqual(frames[:2], [
                    {"type": "status", "status": "booting"},
                    {"type": "status", "status": "model_loading"},
                ])
                self.assertEqual(len(frames), 3)
                self.assertEqual(frames[2]["type"], "fatal")
                self.assertEqual(frames[2]["code"], code)
                self.assertNotIn("private diagnostic", frames[2]["error"])
                self.assertIn("private diagnostic", stderr.getvalue())

    def test_real_process_uses_default_local_only_factory_and_ndjson_transport(self):
        fake_qwen = '''
import os
__version__ = "0.0.6"
from types import SimpleNamespace

assert os.environ["HF_HUB_OFFLINE"] == "1"
assert os.environ["TRANSFORMERS_OFFLINE"] == "1"
print("QWEN_IMPORT_NOISE")

class Qwen3ASRModel:
    @classmethod
    def from_pretrained(cls, path, **kwargs):
        assert os.path.isabs(path)
        assert kwargs["device_map"] == "cpu"
        print("QWEN_LOAD_NOISE")
        os.write(1, b"QWEN_NATIVE_FD_NOISE\\n")
        return cls()

    def transcribe(self, *, audio, language):
        samples, rate = audio
        assert rate == 16000
        assert samples.dtype.name == "float32"
        print("QWEN_INFERENCE_NOISE")
        return [SimpleNamespace(text="subprocess transcript", language="English")]
'''
        fake_torch = '''
from types import SimpleNamespace
float16 = "float16"
float32 = "float32"
backends = SimpleNamespace(mps=SimpleNamespace(is_available=lambda: False))
'''
        fake_numpy = '''
from types import SimpleNamespace
float32 = "float32"

class FakeArray:
    dtype = SimpleNamespace(name="float32")
    def astype(self, _dtype):
        return self
    def __truediv__(self, _value):
        return self

def frombuffer(_pcm, dtype):
    assert dtype == "<i2"
    return FakeArray()
'''
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            (temporary_path / "qwen_asr.py").write_text(fake_qwen, encoding="utf-8")
            (temporary_path / "torch.py").write_text(fake_torch, encoding="utf-8")
            (temporary_path / "numpy.py").write_text(fake_numpy, encoding="utf-8")
            model_path = temporary_path / "model"
            model_path.mkdir()
            (model_path / "config.json").write_text("{}", encoding="utf-8")
            config_sha256 = __import__("hashlib").sha256((model_path / "config.json").read_bytes()).hexdigest()
            (model_path / "model-manifest.json").write_text(json.dumps({
                "schemaVersion": 1,
                "repoId": "Qwen/Qwen3-ASR-0.6B",
                "revision": "5eb144179a02acc5e5ba31e748d22b0cf3e303b0",
                "modelPath": str(model_path.resolve()),
                "configSha256": config_sha256,
                "installedAt": "2026-07-19T00:00:00Z",
            }), encoding="utf-8")
            env = dict(os.environ)
            env["VOICE_VAC_QWEN_MODEL_PATH"] = str(model_path)
            env["PYTHONPATH"] = os.pathsep.join([str(temporary_path), str(ASR_ROOT)])
            child = subprocess.Popen(
                [sys.executable, str(ASR_ROOT / "voivox_asr_worker.py")],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            request = {
                "id": "process_1",
                "pcm": base64.b64encode(b"\x00\x00\xff\x7f").decode(),
                "sampleRate": 16000,
                "channels": 1,
                "language": None,
            }
            stdout, stderr = child.communicate(json.dumps(request) + "\n", timeout=10)

        self.assertEqual(child.returncode, 0, stderr)
        frames = [json.loads(line) for line in stdout.splitlines()]
        self.assertEqual([frame["type"] for frame in frames], ["status", "status", "ready", "accepted", "result"])
        self.assertEqual(frames[-1]["text"], "subprocess transcript")
        self.assertIn("QWEN_IMPORT_NOISE", stderr)
        self.assertIn("QWEN_LOAD_NOISE", stderr)
        self.assertIn("QWEN_NATIVE_FD_NOISE", stderr)
        self.assertIn("QWEN_INFERENCE_NOISE", stderr)


if __name__ == "__main__":
    unittest.main()
