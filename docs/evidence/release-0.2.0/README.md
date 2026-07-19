# Voice VAC 0.2.0 release evidence

This directory is the curated evidence index for the `Voice VAC` `v0.2.0` release. It is intentionally initialized without validation claims. A gate changes from **Not run** only after its prescribed automated checks and real operator procedure have completed and the resulting evidence has been reviewed.

## Release record

- Status: **Not run**
- Machine: Not recorded
- Git commit: Not recorded
- Git branch: Not recorded
- Evidence index updated: Not recorded
- Public artifact hashes: Not recorded

## Gate index

| Gate | Status | Evidence | Evidence SHA-256 |
| --- | --- | --- | --- |
| Release contract and preflight | Not run | `environment.json` | Not recorded |
| Blender 64-joint asset and visual QA | Not run | `blender-asset-qa.json`, `blender-asset-qa.md`, `assets/blender-*` | Not recorded |
| Native capsule, hose physics, and interaction QA | Not run | `native-overlay-qa.md`, `assets/native-*` | Not recorded |
| Store and Automation Extension package scans | Not run | `store-extension-scan.json`, `automation-extension-scan.json` | Not recorded |
| Deterministic real-Chrome Store-path video E2E | Not run | `real-chrome-video-e2e.md`, `assets/chrome-*` | Not recorded |
| Multi-display, Retina, Spaces, and click-through QA | Not run | `multidisplay-qa.md`, `assets/display-*` | Not recorded |
| Permission and target-tab audio isolation QA | Not run | `audio-isolation.json`, `audio-isolation.md`, `assets/audio-*` | Not recorded |
| Local Qwen ASR and packaged MCP E2E | Not run | `asr-mcp-e2e.json`, `asr-mcp-e2e.md`, `assets/mcp-*` | Not recorded |
| Public documentation and verified visuals | Not run | repository public documentation and `docs/assets/` | Not recorded |
| DMG, dual ZIPs, checksums, signing, and clean install | Not run | `clean-install.md`, `assets/codesign-verify.txt`, `assets/gatekeeper-assessment.txt`, `assets/clean-*` | Not recorded |
| Final clean-checkout gate, CI, and draft release | Not run | final-gate log and draft release URL | Not recorded |

## Evidence rules

- Generated binaries and raw logs remain under ignored `dist/` or `/tmp` paths.
- Curated JSON, Markdown, screenshots, and short recordings belong in this directory.
- Automated tests must use temporary output paths and must never replace curated evidence.
- Each manual gate records the operator action, expected observable result, UTC timestamp, artifact hash, and evidence path.
- Ad-hoc signing and Gatekeeper behavior are reported exactly as observed; notarization is not claimed.
