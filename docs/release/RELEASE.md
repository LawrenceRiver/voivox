# VOIVOX release runbook

VOIVOX currently ships as an ad-hoc-signed, non-notarized macOS arm64 App candidate, a standalone Chrome MV3 ZIP, and a Codex MCP launcher bundled inside the App. Ad-hoc signing seals the local bundle but does not establish an Apple-verified developer identity.

## Release gate

From a clean checkout on macOS:

```bash
npm ci
npm test
npm run typecheck
npm run build
(cd native/macos && swift test)
git diff --check
```

Then create judge-ready artifacts:

```bash
npm run package:mac --workspace=@voivox/desktop
npm run package:zip --workspace=@voivox/chrome-extension
```

Expected output:

- `apps/desktop/release/VOIVOX-0.1.0-arm64.dmg`
- `apps/desktop/release/VOIVOX-0.1.0-arm64.zip`
- `apps/chrome-extension/release/VOIVOX-Chrome-Extension-0.1.0.zip`

The App contains the selected-process native host, Native Messaging host, optional Python ASR worker, and a standalone Codex MCP bundle/launcher. Browser model weights are intentionally not embedded; Chrome downloads the selected pinned model on first use.

## Judge install

1. Open the DMG (or unzip the App archive), drag/copy `VOIVOX.app` into `/Applications`, and open it there. Because the current candidate is not Developer ID signed or notarized, macOS may require right-clicking the App and choosing **Open** once. Installing at this exact path also makes the packaged MCP command below work unchanged.
2. Unzip the Chrome artifact, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select the unzipped folder.
3. Pin VOIVOX. Open a playing media tab, click VOIVOX, and click the main capture button. Tab audio is always transcribed inside the extension. The App is optional; when open, it receives only the completed text automatically.
4. Add the packaged MCP without installing Node:

   ```bash
   codex mcp add voivox -- /Applications/VOIVOX.app/Contents/Resources/voivox/voivox-mcp
   ```

5. Open VOIVOX before asking Codex to call `voivox_status` or read sessions.

## Signing and notarization before a general public release

The repository does not contain Apple credentials. A maintainer with an Apple Developer ID must configure electron-builder signing, notarize both App artifacts, staple the ticket, and test Gatekeeper on a clean Mac. Do not describe an unsigned candidate as notarized.

Recommended checks:

```bash
codesign --verify --deep --strict --verbose=2 /Applications/VOIVOX.app
spctl --assess --type execute --verbose=4 /Applications/VOIVOX.app
```

## GitHub release

- Tag the exact verified commit (for example `v0.1.0`).
- Let `.github/workflows/package-macos.yml` rebuild the candidate.
- Attach the DMG, macOS ZIP, Chrome ZIP, checksums, and release notes.
- State clearly that the judge build is ad-hoc signed but not Developer ID signed or notarized.
- Re-run the judge install from the uploaded artifacts, not from the working tree.
