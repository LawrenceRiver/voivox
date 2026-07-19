#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CONTENTS_DIR=$(dirname -- "$(dirname -- "$SCRIPT_DIR")")

export ELECTRON_RUN_AS_NODE=1
exec "$CONTENTS_DIR/MacOS/Voice Vac" "$SCRIPT_DIR/voivox-mcp.mjs"
