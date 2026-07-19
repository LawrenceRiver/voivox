#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
python_bin="${VOICE_VAC_BOOTSTRAP_PYTHON:-${VOIVOX_BOOTSTRAP_PYTHON:-python3.12}}"
data_dir="${VOICE_VAC_DATA_DIR:-${VOIVOX_DATA_DIR:-$HOME/Library/Application Support/Voice VAC}}"
runtime_dir="$data_dir/asr-venv"
model_dir="$data_dir/models/Qwen3-ASR-0.6B"

if ! command -v "$python_bin" >/dev/null 2>&1; then
  echo "Voice VAC needs Python 3.12. Install it, then rerun with VOICE_VAC_BOOTSTRAP_PYTHON=/path/to/python3.12." >&2
  exit 1
fi

"$python_bin" - <<'PY'
import sys
if sys.version_info[:2] != (3, 12):
    raise SystemExit("Voice VAC requires Python 3.12 exactly for the pinned local ASR runtime.")
PY

mkdir -p "$data_dir"
"$python_bin" -m venv "$runtime_dir"
"$runtime_dir/bin/python" -m pip install --upgrade pip
"$runtime_dir/bin/python" -m pip install --requirement "$repo_root/native/asr/requirements.txt"
"$runtime_dir/bin/python" "$repo_root/scripts/download-qwen-model.py" --model-dir "$model_dir"

echo "Voice VAC local ASR runtime installed at: $runtime_dir"
echo "Voice VAC pinned Qwen model installed at: $model_dir"
echo "Runtime inference is offline; restart Voice VAC to load the verified local model."
