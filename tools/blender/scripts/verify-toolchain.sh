#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
BLENDER_BIN="$(command -v blender || true)"
MCP_BIN="$ROOT/tools/blender/.venv313/bin/blender-mcp-server"

if [[ -z "$BLENDER_BIN" ]]; then
  echo "Blender executable not found" >&2
  exit 1
fi
if [[ ! -x "$MCP_BIN" ]]; then
  echo "Blender MCP executable not found at $MCP_BIN" >&2
  exit 1
fi

echo "Blender: $BLENDER_BIN"
blender --version | head -2
echo "MCP: $MCP_BIN"
"$MCP_BIN" --help >/dev/null
echo "Voice Vac toolchain: OK"
