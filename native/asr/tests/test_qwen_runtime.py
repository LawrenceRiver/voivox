import os
import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace


ASR_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ASR_ROOT))

from qwen_runtime import QwenRuntime, RuntimeFailure  # noqa: E402


class FakeModel:
    def __init__(self):
        self.calls = []

    def transcribe(self, *, audio, language):
        self.calls.append((audio, language))
        return [SimpleNamespace(text="你好 Voice VAC", language="Chinese")]


class FakeModelClass:
    calls = []
    failures = set()
    models = []

    @classmethod
    def reset(cls):
        cls.calls = []
        cls.failures = set()
        cls.models = []

    @classmethod
    def from_pretrained(cls, path, **kwargs):
        cls.calls.append((path, kwargs))
        if kwargs["device_map"] in cls.failures:
            raise RuntimeError("device construction failed")
        model = FakeModel()
        cls.models.append(model)
        return model


class QwenRuntimeTests(unittest.TestCase):
    def setUp(self):
        FakeModelClass.reset()

    def make_model_dir(self, parent):
        model_dir = Path(parent) / "Qwen3-ASR-0.6B"
        model_dir.mkdir()
        (model_dir / "config.json").write_text("{}", encoding="utf-8")
        return model_dir

    def test_requires_an_absolute_local_model_with_config(self):
        with self.assertRaises(RuntimeFailure) as relative:
            QwenRuntime.from_local_path(
                "relative/model",
                model_class=FakeModelClass,
                torch_module=self.fake_torch(mps_available=False),
            )
        self.assertEqual(relative.exception.code, "ASR_MODEL_MISSING")

        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(RuntimeFailure) as missing:
                QwenRuntime.from_local_path(
                    temporary,
                    model_class=FakeModelClass,
                    torch_module=self.fake_torch(mps_available=False),
                )
        self.assertEqual(missing.exception.code, "ASR_MODEL_MISSING")

    def test_sets_offline_flags_before_loading_and_uses_cpu_float32(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = self.make_model_dir(temporary)
            runtime = QwenRuntime.from_local_path(
                str(model_dir),
                model_class=FakeModelClass,
                torch_module=self.fake_torch(mps_available=False),
            )

        self.assertEqual(os.environ["HF_HUB_OFFLINE"], "1")
        self.assertEqual(os.environ["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(runtime.device, "cpu")
        self.assertEqual(runtime.model_id, "Qwen/Qwen3-ASR-0.6B")
        _, kwargs = FakeModelClass.calls[0]
        self.assertEqual(
            kwargs,
            {
                "device_map": "cpu",
                "dtype": "float32",
                "max_inference_batch_size": 1,
                "max_new_tokens": 256,
            },
        )

    def test_tries_mps_float16_then_falls_back_to_cpu_float32(self):
        FakeModelClass.failures.add("mps")
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = self.make_model_dir(temporary)
            runtime = QwenRuntime.from_local_path(
                str(model_dir),
                model_class=FakeModelClass,
                torch_module=self.fake_torch(mps_available=True),
            )

        self.assertEqual(runtime.device, "cpu")
        self.assertEqual([call[1]["device_map"] for call in FakeModelClass.calls], ["mps", "cpu"])
        self.assertEqual(FakeModelClass.calls[0][1]["dtype"], "float16")
        self.assertEqual(FakeModelClass.calls[1][1]["dtype"], "float32")

    def test_maps_missing_package_and_model_construction_failure_to_stable_codes(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = self.make_model_dir(temporary)
            with self.assertRaises(RuntimeFailure) as missing_runtime:
                QwenRuntime.from_local_path(str(model_dir), dependency_loader=lambda: (_ for _ in ()).throw(ImportError("no qwen")))
        self.assertEqual(missing_runtime.exception.code, "ASR_RUNTIME_MISSING")

        FakeModelClass.failures.update({"mps", "cpu"})
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = self.make_model_dir(temporary)
            with self.assertRaises(RuntimeFailure) as failed_model:
                QwenRuntime.from_local_path(
                    str(model_dir),
                    model_class=FakeModelClass,
                    torch_module=self.fake_torch(mps_available=True),
                )
        self.assertEqual(failed_model.exception.code, "ASR_MODEL_LOAD_FAILED")

    def test_decodes_little_endian_pcm16_directly_to_float32(self):
        with tempfile.TemporaryDirectory() as temporary:
            model_dir = self.make_model_dir(temporary)
            runtime = QwenRuntime.from_local_path(
                str(model_dir),
                model_class=FakeModelClass,
                torch_module=self.fake_torch(mps_available=False),
            )
            pcm = struct.pack("<hhhh", -32768, -16384, 0, 32767)
            result = runtime.transcribe_pcm(pcm, sample_rate=16000, language=None)

        samples, sample_rate = FakeModelClass.models[0].calls[0][0]
        self.assertEqual(sample_rate, 16000)
        self.assertEqual(samples.dtype.name, "float32")
        self.assertAlmostEqual(float(samples[0]), -1.0)
        self.assertAlmostEqual(float(samples[1]), -0.5)
        self.assertAlmostEqual(float(samples[2]), 0.0)
        self.assertAlmostEqual(float(samples[3]), 32767 / 32768)
        self.assertEqual(result, {"text": "你好 Voice VAC", "language": "Chinese"})

    @staticmethod
    def fake_torch(*, mps_available):
        return SimpleNamespace(
            float16="float16",
            float32="float32",
            backends=SimpleNamespace(mps=SimpleNamespace(is_available=lambda: mps_available)),
        )


if __name__ == "__main__":
    unittest.main()
