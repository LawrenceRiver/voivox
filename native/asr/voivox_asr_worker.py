#!/usr/bin/env python3
"""Persistent VOIVOX adapter for mlx-qwen3-asr.

Requests and responses are newline-delimited JSON. Audio is received as in-memory
16 kHz signed PCM and written only to a temporary WAV file for the duration of
one local inference call.
"""

import base64
import json
import os
import sys
import tempfile
import wave


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main():
    try:
        from mlx_qwen3_asr import Session
    except Exception as error:
        for line in sys.stdin:
            try:
                request = json.loads(line)
                emit({"id": request.get("id"), "error": "VOIVOX local ASR is not installed. Install mlx-qwen3-asr with Python 3.10+ first: " + str(error)})
            except Exception:
                pass
        return

    session = Session(model=os.environ.get("VOIVOX_QWEN_MODEL", "Qwen/Qwen3-ASR-0.6B"))
    for line in sys.stdin:
        request = json.loads(line)
        request_id = request.get("id")
        temporary_path = None
        try:
            audio_path = request.get("audioPath")
            if not audio_path:
                pcm = base64.b64decode(request["pcm"])
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temporary:
                    temporary_path = temporary.name
                with wave.open(temporary_path, "wb") as wav:
                    wav.setnchannels(int(request.get("channels", 1)))
                    wav.setsampwidth(2)
                    wav.setframerate(int(request.get("sampleRate", 16000)))
                    wav.writeframes(pcm)
                audio_path = temporary_path
            result = session.transcribe(audio_path)
            emit({"id": request_id, "text": str(result.text)})
        except Exception as error:
            emit({"id": request_id, "error": str(error)})
        finally:
            if temporary_path:
                try:
                    os.unlink(temporary_path)
                except FileNotFoundError:
                    pass


if __name__ == "__main__":
    main()
