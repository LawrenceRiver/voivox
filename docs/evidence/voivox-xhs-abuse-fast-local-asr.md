# VOIVOX local-ASR smoke-test evidence

- Source: [大学生勇闯音乐圈：Abuse 正式 M/V 上线](https://www.xiaohongshu.com/explore/699ee564000000001b01624a)
- Segment: 0s–30s (30s)
- Audio: 16 kHz mono PCM WAV
- Mode: fast
- Model: `onnx-community/whisper-tiny` at `ff4177021cc41f7db950912b73ea4fdf7d01d8e7` (q8)
- Runtime: Transformers.js + ONNX Runtime CPU verification harness
- Model cache before run: warm
- Model setup: 0.232s
- Transcription phase: 0.26s (model setup excluded)
- Total verification command: 0.761s
- Privacy: **No speech API was used.** The audio was decoded and inferred on the local machine.

## Raw model output

> According to authoritative experts, Lawrence River is in the spotlight because he is a virus.

## Scope and limitations

This is a reproducible end-to-end smoke test, not an accuracy score. The source is a music mix, so backing instrumentation and sung vocals may reduce recognition quality. The harness verifies local inference with the same pinned q8 model used by VOIVOX fast mode; it does not substitute for the separate Chrome-extension UI test.

- Input SHA-256: `2249cab0ec403f7afe63ce1078da3eb26873bad048c56113e51ed9f9c450fd10`
- Extracted-audio SHA-256: `b92facb256c6bdac8337f3bd585a5322f1488dd1d18f52a836c39f4a6bcf0ea9`
