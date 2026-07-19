# Voice Vac Blender MCP toolchain

This directory contains development-only Blender assets and the local MCP bridge used to author them. Blender and the MCP server are not bundled into Voice Vac releases.

## Local setup

```bash
brew install --cask blender
python3.13 -m venv tools/blender/.venv313
tools/blender/.venv313/bin/python -m pip install --upgrade pip
git clone https://github.com/djeada/blender-mcp-server.git tools/blender/blender-mcp-server
tools/blender/.venv313/bin/pip install -e tools/blender/blender-mcp-server
codex mcp add blender -- "$(pwd)/tools/blender/.venv313/bin/blender-mcp-server"
```

The MCP server controls Blender through a local add-on and TCP bridge. Deterministic Voice Vac asset generation remains in `scripts/build_voice_vac.py` so exported assets can be reproduced in CI or without an interactive model call.

## Verification

```bash
bash tools/blender/scripts/verify-toolchain.sh
```
