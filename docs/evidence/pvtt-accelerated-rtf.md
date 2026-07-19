# Voice Vac PVTT accelerated-mode evidence

Status: decode and merge boundary verified; no universal speed claim is made.

`apps/desktop/src/main/ffmpeg-audio-decoder.ts` decodes an authorized local media file with FFmpeg into 16 kHz mono PCM, creates bounded overlapping chunks, and passes them to `AcceleratedTranscriber`. The transcriber runs chunks concurrently, sorts them by source time, removes exact overlap duplicates, and returns `processing_mode: accelerated_batch`.

Run the deterministic coverage with:

```bash
npx vitest run apps/desktop/tests/media-source-detector.test.ts apps/desktop/tests/accelerated-transcriber.test.ts
```

An actual RTF report must record the host CPU/GPU, model revision and precision, chunk concurrency, media acquisition time, inference time, and whether timestamp alignment was included. The current release does not claim that every ten-minute video completes in seconds.
