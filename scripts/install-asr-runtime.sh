#!/usr/bin/env bash
set -euo pipefail

python_bin="${VOIVOX_BOOTSTRAP_PYTHON:-python3.10}"
data_dir="${VOIVOX_DATA_DIR:-$HOME/Library/Application Support/VOIVOX}"
runtime_dir="$data_dir/asr-venv"

if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "VOIVOX needs Python 3.10 or newer. Install it, then rerun with VOIVOX_BOOTSTRAP_PYTHON=/path/to/python3.10." >&2
  exit 1
fi

"$python_bin" - <<'PY'
import sys
if sys.version_info < (3, 10):
    raise SystemExit("VOIVOX needs Python 3.10 or newer.")
PY

mkdir -p "$data_dir"
"$python_bin" -m venv "$runtime_dir"
"$runtime_dir/bin/python" -m pip install --upgrade pip
"$runtime_dir/bin/python" -m pip install "mlx-qwen3-asr[aligner]"

echo "VOIVOX local ASR runtime installed at: $runtime_dir"
echo "Open or restart VOIVOX. The Qwen3-ASR 0.6B model downloads on the first transcription."
