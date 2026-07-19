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

## Runtime asset split

- `VoiceVACDevice.usdz` is the RealityKit device/nozzle/button asset and is exported in its true docked/button-up rest pose.
- `VoiceVACHose.usdz` is a static RealityKit loadability and authoring diagnostic. USD skeleton path tokens are not treated as `Entity` controls.
- `VoiceVACHose.meshbin` is the versioned little-endian runtime hose asset for the transparent `MTKView` Metal skinning path. It contains rest geometry, two-influence weights, 64 bind/inverse-bind matrix pairs, two measured high-curvature correctives, material parameters, offsets, bounds, and an embedded payload SHA-256.
- `asset-contract.json` binds these files by byte count and SHA-256 and declares `hoseRuntime.renderer = metalSkinning`.

Rebuild and validate the checked-in artifacts with:

```bash
blender -b --python tools/blender/scripts/build_voice_vac.py -- \
  --output-dir tools/blender/assets
blender -b tools/blender/assets/voice-vac-machine.blend \
  --python tools/blender/scripts/validate_voice_vac.py -- \
  --contract tools/blender/assets/asset-contract.json \
  --preview docs/assets/voice-vac-native-preview.png
```

## Verification

```bash
bash tools/blender/scripts/verify-toolchain.sh
```
