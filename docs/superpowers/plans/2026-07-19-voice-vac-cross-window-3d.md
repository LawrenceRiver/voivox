# Voice Vac Cross-Window 3D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver a verified Voice Vac prototype where a small desktop capsule connects through a spring-like 3D hose to a video target inside Chrome, then routes only that tab's audio into the existing PVTT transcription pipeline.

**Architecture:** Blender and a local Blender MCP are development-only authoring tools. Blender exports a tested GLB asset pack. The desktop app renders the asset with Three.js, while a Chrome content-script overlay renders the page-side nozzle. A local bridge synchronizes session state and screen coordinates; the existing tabCapture/Offscreen/ASR/MCP pipeline remains the audio and transcript path.

**Tech Stack:** Blender 4.x, `djeada/blender-mcp-server`, Blender Python API, GLB/glTF, Three.js `GLTFLoader`, Electron transparent always-on-top windows, Chrome Manifest V3 content scripts, loopback WebSocket/HTTP, Vitest, Playwright/Computer Use.

## Global Constraints

- Do not capture system audio, microphone audio, other tabs, or DRM-protected media.
- Do not ship Blender or Blender MCP inside the final Voice Vac App.
- Keep the App as a small glass capsule, not a dashboard.
- Preserve existing App, Extension, MCP, ASR, and accelerated-mode behavior.
- Use stable GLB node names and animation names: `idle`, `drag`, `stretch`, `snap`, `suction`, `complete`, `collapse`, `error`.

---

### Task 1: Install and register the 3D authoring toolchain

**Files:**
- Create: `tools/blender/README.md`
- Create: `tools/blender/blender-mcp-config.example.json`
- Create: `tools/blender/scripts/verify-toolchain.sh`

**Interfaces:** Produces a local Blender installation, an MCP server virtual environment, and a documented Codex CLI registration command.

- [ ] **Step 1: Install Blender and MCP server**

```bash
brew install --cask blender
python3 -m venv tools/blender/.venv
tools/blender/.venv/bin/python -m pip install --upgrade pip
git clone https://github.com/djeada/blender-mcp-server.git tools/blender/blender-mcp-server
tools/blender/.venv/bin/pip install -e tools/blender/blender-mcp-server
```

- [ ] **Step 2: Register and verify the server**

```bash
codex mcp add blender -- "$(pwd)/tools/blender/.venv/bin/blender-mcp-server"
codex mcp list
bash tools/blender/scripts/verify-toolchain.sh
```

Expected output includes Blender version, MCP executable path, and `Voice Vac toolchain: OK`.

- [ ] **Step 3: Document the reproducible setup and commit it**

```bash
git add tools/blender
git commit -m "chore: document Voice Vac Blender MCP toolchain"
```

### Task 2: Create and validate a game-quality Blender asset

**Files:**
- Create: `tools/blender/scripts/build_voice_vac.py`
- Create: `tools/blender/scripts/validate_voice_vac.py`
- Create: `tools/blender/assets/voice-vac-machine.blend`
- Create: `tools/blender/assets/voice-vac-machine.glb`

**Interfaces:** `build_voice_vac.py --output-dir <dir>` creates the GLB and Blender source; the validator asserts stable nodes `VoiceVacBody`, `PortLeft`, `PortRight`, `HoseRoot`, `HoseTip`, `NozzleEyes` and clips `idle`, `drag`, `stretch`, `snap`, `suction`, `complete`, `collapse`, `error`.

- [ ] **Step 1: Write the validator before the asset generator**
- [ ] **Step 2: Generate the beveled glass capsule, ports, double-eye nozzle, ribbed hose, bone chain, PBR materials, lights, camera, and named animation clips**
- [ ] **Step 3: Export and validate**

```bash
blender --background --python tools/blender/scripts/build_voice_vac.py -- --output-dir tools/blender/assets
blender --background tools/blender/assets/voice-vac-machine.blend --python tools/blender/scripts/validate_voice_vac.py
```

- [ ] **Step 4: Commit the reproducible asset source and output**

```bash
git add tools/blender
git commit -m "feat: add Voice Vac game-ready GLB asset"
```

### Task 3: Load the GLB in the desktop renderer

**Files:**
- Create: `packages/ui/src/VoiceVacAsset.ts`
- Modify: `packages/ui/src/VacuumMachine3D.tsx`
- Modify: `packages/ui/tests/TunnelMachine.test.tsx`

**Interfaces:** `VoiceVacAsset.load(scene, url)`, `setState(state)`, `setHoseTarget(point)`, and `dispose()`.

- [ ] **Step 1: Add a failing test for GLB marker and state transition**
- [ ] **Step 2: Implement `GLTFLoader.loadAsync`, one AnimationMixer, named clip mapping, and existing pointer-drag API**
- [ ] **Step 3: Keep CSS fallback only for WebGL/asset failure and show a recoverable warning**
- [ ] **Step 4: Run focused tests and typecheck**

```bash
npm test --workspace=@voivox/ui -- TunnelMachine
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/ui
git commit -m "feat: load Voice Vac GLB asset in Three.js"
```

### Task 4: Implement the cross-window session bridge

**Files:**
- Create: `packages/core/src/cross-window-session.ts`
- Create: `packages/core/tests/cross-window-session.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `apps/desktop/electron/main.ts`
- Modify: `apps/desktop/electron/preload.ts`

**Interfaces:** `CrossWindowSessionStore.create(tabId)`, `update(id, patch)`, `get(id)`, and `close(id)`; each session contains `id`, `tabId`, `state`, `appEndpoint`, `pageEndpoint`, and `targetRect`.

- [ ] **Step 1: Write lifecycle and stale-session tests**
- [ ] **Step 2: Implement the in-memory store and loopback messages**
- [ ] **Step 3: Add Electron IPC for start, endpoint update, and close**
- [ ] **Step 4: Run `npm test --workspace=@voivox/core -- cross-window-session`**
- [ ] **Step 5: Commit**

```bash
git add packages/core apps/desktop/electron
git commit -m "feat: add cross-window Voice Vac session bridge"
```

### Task 5: Add the Chrome page-side nozzle and video snap target

**Files:**
- Modify: `apps/chrome-extension/src/content-tunnel.ts`
- Modify: `apps/chrome-extension/public/content-tunnel.css`
- Modify: `apps/chrome-extension/src/bridge.ts`
- Create: `apps/chrome-extension/tests/content-tunnel-cross-window.test.ts`

**Interfaces:** `mountPageNozzle(sessionId, bridge)`, `findVideoTargets()`, and `snapToVideo(sessionId, rect)`.

- [ ] **Step 1: Write tests for detection, target selection, snap, coordinate updates, and cleanup**
- [ ] **Step 2: Implement a Shadow DOM overlay with isolated pointer events**
- [ ] **Step 3: Render the page-side nozzle and hose segment**
- [ ] **Step 4: Publish `targetRect` and endpoint coordinates on scroll, resize, and visibility changes**
- [ ] **Step 5: Run tests and build**

```bash
npm test --workspace=@voivox/chrome-extension -- content-tunnel
npm run build --workspace=@voivox/chrome-extension
```

- [ ] **Step 6: Commit**

```bash
git add apps/chrome-extension
git commit -m "feat: add Chrome video nozzle overlay"
```

### Task 6: Connect the desktop capsule to the page nozzle

**Files:**
- Modify: `apps/desktop/src/renderer/tunnel-machine-panel.tsx`
- Modify: `apps/desktop/src/renderer/styles.css`
- Modify: `packages/ui/src/TunnelMachine.tsx`
- Create: `apps/desktop/tests/cross-window-tunnel.test.tsx`

**Interfaces:** `TunnelMachinePanel` starts a session, sends drag coordinates, receives page endpoint updates, and renders the desktop-side hose curve.

- [ ] **Step 1: Add an integration test for `dragging → detecting → ready`**
- [ ] **Step 2: Implement screen-coordinate conversion and debounced publishing**
- [ ] **Step 3: Render the cross-window hose and state animations**
- [ ] **Step 4: Preserve capsule sizing and glass-only controls**
- [ ] **Step 5: Run `npm test --workspace=@voivox/desktop -- cross-window-tunnel`**
- [ ] **Step 6: Commit**

```bash
git add apps/desktop packages/ui
git commit -m "feat: connect Voice Vac capsule to Chrome video"
```

### Task 7: Verify isolation, MCP output, and release artifacts

**Files:**
- Create: `docs/evidence/voice-vac-cross-window-3d.md`
- Modify: `docs/evidence/pvtt-audio-isolation.md`
- Modify: `README.md`
- Modify: `docs/release/RELEASE.md`

- [ ] **Step 1: Run `npm test`, `npm run typecheck`, and `npm run build`**
- [ ] **Step 2: Package App and Extension**

```bash
npm run package:mac --workspace=@voivox/desktop
npm run package:zip --workspace=@voivox/chrome-extension
```

- [ ] **Step 3: Use Computer Use to verify idle, drag, ready, transcribing, and completed states on the packaged App**
- [ ] **Step 4: Verify target-tab-only capture, unchanged system devices, and structured `transcribe_active_video` output**
- [ ] **Step 5: Save screenshots/logs and commit release evidence**

```bash
git add docs README.md
git commit -m "docs: verify Voice Vac cross-window 3D release"
```
