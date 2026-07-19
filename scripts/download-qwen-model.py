#!/usr/bin/env python3
"""Install the one pinned Voice VAC Qwen model and atomically certify it."""

import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download


REPO_ID = "Qwen/Qwen3-ASR-0.6B"
REVISION = "5eb144179a02acc5e5ba31e748d22b0cf3e303b0"


def install_model(model_dir, downloader=snapshot_download):
    model_path = Path(model_dir).expanduser().resolve()
    model_path.mkdir(parents=True, exist_ok=True)
    downloader(
        repo_id=REPO_ID,
        revision=REVISION,
        local_dir=str(model_path),
    )
    if not (model_path / "config.json").is_file():
        raise RuntimeError("The pinned Qwen snapshot did not contain config.json.")
    config_sha256 = hashlib.sha256((model_path / "config.json").read_bytes()).hexdigest()

    manifest = {
        "schemaVersion": 1,
        "repoId": REPO_ID,
        "revision": REVISION,
        "modelPath": str(model_path),
        "configSha256": config_sha256,
        "installedAt": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    }
    manifest_path = model_path / "model-manifest.json"
    temporary_path = model_path / ".model-manifest.json.tmp"
    with temporary_path.open("w", encoding="utf-8") as output:
        json.dump(manifest, output, ensure_ascii=False, indent=2, sort_keys=True)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary_path, manifest_path)
    return manifest_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-dir", required=True)
    arguments = parser.parse_args()
    manifest_path = install_model(arguments.model_dir)
    print(manifest_path)


if __name__ == "__main__":
    main()
