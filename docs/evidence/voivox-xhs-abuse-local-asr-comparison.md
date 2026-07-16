# VOIVOX Fast / Quality local-ASR comparison

This comparison uses the same 0–30 second segment from [大学生勇闯音乐圈：Abuse 正式 M/V 上线](https://www.xiaohongshu.com/explore/699ee564000000001b01624a). FFmpeg extracted the same 16 kHz mono PCM audio for both runs. No speech API was used; model inference ran locally.

| Mode | Pinned model | Cache before run | Model setup | Transcription | Total command |
| --- | --- | --- | ---: | ---: | ---: |
| Fast | `onnx-community/whisper-tiny` @ `ff4177021cc41f7db950912b73ea4fdf7d01d8e7`, q8 | warm | 0.232s | 0.260s | 0.761s |
| Quality | `onnx-community/whisper-base` @ `1846881b6b3a3024392c1eea3ad983695bc23925`, q8 | cold | 11.286s | 0.431s | 11.973s |

The setup timings are not an apples-to-apples speed benchmark: the Fast run used an existing local cache, while the recorded Quality run downloaded and loaded its model artifacts for the first time. Downloading open model weights is not speech recognition as a service; the MV audio was not uploaded for transcription.

## Unedited raw outputs

Fast:

> According to authoritative experts, Lawrence River is in the spotlight because he is a virus.

Quality:

> According to authoritative experts, Lawrence River is in the spotlight because he is a virus.

Quality produced the same text as Fast for this segment, so this run does not show a recognition improvement from the larger model. The output is coherent, but there is no human-verified ground-truth transcript in this test; this evidence proves the local no-API path, not transcription accuracy.

Machine-readable records: [Fast JSON](./voivox-xhs-abuse-fast-local-asr.json) and [Quality JSON](./voivox-xhs-abuse-quality-local-asr.json).

- Input SHA-256: `2249cab0ec403f7afe63ce1078da3eb26873bad048c56113e51ed9f9c450fd10`
- Extracted-audio SHA-256: `b92facb256c6bdac8337f3bd585a5322f1488dd1d18f52a836c39f4a6bcf0ea9`
