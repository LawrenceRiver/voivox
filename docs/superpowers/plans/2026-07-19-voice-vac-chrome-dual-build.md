# Voice VAC Chrome Dual Build Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship physically separate Voice VAC Store and Voice VAC Automation Manifest V3 bundles that bind capture to the armed `tabId + documentId`, accept the native nozzle drop, and start, pause, resume, or stop only the selected tab.

**Architecture:** Shared target/session/capture code is injected into two different service-worker entry points. The Store entry point imports only the HTML media playback driver; the Automation entry point imports the CDP driver and alone receives `debugger`. A version-two Native Messaging port relays desktop commands to the fixed target session, while the offscreen document owns only the captured tab stream and local ASR buffer.

**Tech Stack:** TypeScript 5.8, Chrome Manifest V3 (Chrome 116+), esbuild 0.25, Vitest 3, `chrome.tabCapture`, Offscreen Documents, Native Messaging, Swift 6 Native Host, Node loopback bridge.

## Global Constraints

- User-visible brand is exactly `Voice VAC`; internal package names and `com.voivox.bridge` remain compatibility identifiers.
- Store permissions are exactly `activeTab`, `scripting`, `tabCapture`, `offscreen`, `nativeMessaging`, and `storage`; Store source and built JavaScript contain zero `chrome.debugger` or CDP bytes.
- Automation is a separate installable extension with a separate public key, extension ID `ciijinidnlbokpbeiabifcnoighmbnmh`, and required `debugger` permission.
- Store keeps extension ID `pepfpbobjbjehhhcjiokmneclohlffno`.
- A target is always identified by stored `tabId + frameId + documentId`; changing the active tab cannot redirect playback or capture.
- The user must click the extension on every new tab or cross-origin navigation before a native drop can arm that document.
- Drop success enters `ready`; capture, playback, and muting begin only after the red-button `capture-start` command.
- Store autoplay failure displays `Press play once in Chrome.` and resumes only after a trusted page click.
- Automation may use `Runtime.evaluate` or `Input.dispatchMouseEvent`, but never `Page.bringToFront`, `Target.activateTarget`, macOS cursor movement, DRM bypass, login bypass, or permission bypass.
- Invalid drops remain deployed in warning state until the user drags again or sends `target-disconnect`.
- Default UI messages are English; transcript text is never translated or rewritten.
- Tests are written and observed failing before production changes; every task ends with focused tests and a commit.

---

## File and Responsibility Map

### Build boundary

- `apps/chrome-extension/config/manifest.base.json` — common MV3 fields with no channel-specific permission or key.
- `apps/chrome-extension/config/manifest.store.json` — Store key, exact six permissions, Store service-worker entry.
- `apps/chrome-extension/config/manifest.automation.json` — Automation key, exact six permissions plus required `debugger`.
- `apps/chrome-extension/scripts/build.mjs` — merge manifests, select one physical service-worker entry, copy static/runtime files, enforce byte boundaries.
- `apps/chrome-extension/scripts/package.mjs` — create channel-labeled ZIPs from `dist/store` and `dist/automation`.
- `apps/chrome-extension/src/service-worker.store.ts` — Store composition root; imports no Automation module.
- `apps/chrome-extension/src/service-worker.automation.ts` — Automation composition root; imports the CDP driver.
- `apps/chrome-extension/src/service-worker-core.ts` — shared message routing and lifecycle registration.

### Targeting and capture

- `apps/chrome-extension/src/drop-protocol.ts` — exact external pasteboard token parser/formatter.
- `apps/chrome-extension/src/video-target.ts` — visible media/iframe/tab-audio target resolution and screen coordinate conversion.
- `apps/chrome-extension/src/target-session.ts` — immutable target/session types and sender validation.
- `apps/chrome-extension/src/target-session-store.ts` — one current session in `chrome.storage.session`.
- `apps/chrome-extension/src/tab-arm.ts` — the only active-tab lookup; injects and records the armed document.
- `apps/chrome-extension/src/playback-driver.ts` — channel-independent playback contract.
- `apps/chrome-extension/src/store-playback-driver.ts` — exact-tab content-script media playback and trusted-click fallback.
- `apps/chrome-extension/src/automation/cdp-playback-driver.ts` — Automation-only CDP attach, playback, click, pause, and detach.
- `apps/chrome-extension/src/capture-errors.ts` — stable codes, English copy, severity, and recovery semantics.
- `apps/chrome-extension/src/capture-controller.ts` — explicit start/pause/resume/stop state machine.
- `apps/chrome-extension/src/content-tunnel.ts` — page arm indicator, drop overlay, target highlight, and Store trusted-click prompt only.
- `apps/chrome-extension/src/offscreen.ts` — stream consumption, PCM buffering, pause/resume, stop/flush, local transcription.

### Desktop command transport

- `packages/core/src/extension-command-broker.ts` — monotonic command queue and bounded long-poll waiters.
- `native/macos/Sources/VOIVOXNativeHost/NativeCommandRelay.swift` — authenticated loopback poll to framed Native Messaging output.
- `apps/chrome-extension/src/native-command-channel.ts` — long-lived `connectNative` port and idempotent command dispatch.

---

### Task 1: Split the manifests and generate stable Store/Automation artifacts

**Files:**
- Create: `apps/chrome-extension/config/manifest.base.json`
- Create: `apps/chrome-extension/config/manifest.store.json`
- Create: `apps/chrome-extension/config/manifest.automation.json`
- Create: `apps/chrome-extension/scripts/build.mjs`
- Create: `apps/chrome-extension/scripts/package.mjs`
- Create: `apps/chrome-extension/tests/manifest-variants.test.ts`
- Create: `apps/chrome-extension/src/service-worker.store.ts`
- Create: `apps/chrome-extension/src/service-worker.automation.ts`
- Modify: `apps/chrome-extension/package.json`
- Modify: `apps/chrome-extension/tests/manifest-identity.test.ts`
- Modify: `apps/chrome-extension/tests/extension-build-artifacts.test.ts`
- Retire after green: `apps/chrome-extension/public/manifest.json`

**Interfaces:**
- Consumes: existing popup/offscreen/content/ASR entry points and static assets.
- Produces: `npm run build:store`, `npm run build:automation`, `npm run build:all`, `npm run package:store`, `npm run package:automation`; output directories `dist/store` and `dist/automation`.

- [ ] **Step 1: Write the failing manifest-variant tests**

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const extensionId = (key: string): string => [...createHash('sha256')
  .update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
  .flatMap((byte) => [byte >> 4, byte & 0x0f])
  .map((nibble) => String.fromCharCode(97 + nibble)).join('');

describe('Voice VAC manifest variants', () => {
  it('pins independent Store and Automation identities and permissions', async () => {
    const store = JSON.parse(await readFile(new URL('../config/manifest.store.json', import.meta.url), 'utf8'));
    const automation = JSON.parse(await readFile(new URL('../config/manifest.automation.json', import.meta.url), 'utf8'));

    expect(extensionId(store.key)).toBe('pepfpbobjbjehhhcjiokmneclohlffno');
    expect(extensionId(automation.key)).toBe('ciijinidnlbokpbeiabifcnoighmbnmh');
    expect(store.permissions).toEqual(['activeTab', 'nativeMessaging', 'offscreen', 'scripting', 'storage', 'tabCapture']);
    expect(store.permissions).not.toContain('debugger');
    expect(automation.permissions).toEqual([...store.permissions, 'debugger']);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/manifest-variants.test.ts apps/chrome-extension/tests/manifest-identity.test.ts
```

Expected: FAIL because the three files under `config/` do not exist and the old identity test still reads `public/manifest.json`.

- [ ] **Step 3: Add the common and variant manifests**

`manifest.base.json` contains `manifest_version`, description, minimum Chrome 116, action, icons, CSP, host permissions, and background type. It contains neither `key` nor `permissions`. The Store key is copied byte-for-byte from the current manifest. The Automation manifest uses this exact public key:

```json
{
  "name": "Voice VAC Automation",
  "key": "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4I698V8DRnNwnDkGzvJfs009OZMCuVfnRff1v4OS243yC/JH/9Xi1KOhmqNTfVcPImSlmS4PqK3tsQuRpNd5tCtYaj5C8/3k94LphHplk2H0FQ7SLdipYWq2SMs4kpFJ1pke4ePIo6v29SwB3iswPAURsox7DWb3ghkvmuJcCS9gVlVihYIFOi49zp5DRUf2xlKYJBXb0dCp8mSmWZdH5ZwX50jWM1USGomxYo5fdmiryBU/tVc2agWnpzx1kJoVDHn8XxY/XzJpOOMEjFbB+ygWL0GI/EuFVUwp0O+o/8gcfAGQHULG0JWZU4VIjPZ3Yxyp6C6C5H+mTD+hX0OOmwIDAQAB",
  "permissions": ["activeTab", "nativeMessaging", "offscreen", "scripting", "storage", "tabCapture", "debugger"]
}
```

The checked-in Automation variant must contain `debugger`; it is not optional, conditional, or added by a user preference. The checked-in Store variant must not contain it.

- [ ] **Step 4: Implement the channel build and package scripts**

Use one named output for the selected physical worker entry:

```js
const entryPoints = {
  popup: 'src/popup.ts',
  'service-worker': channel === 'store'
    ? 'src/service-worker.store.ts'
    : 'src/service-worker.automation.ts',
  offscreen: 'src/offscreen.ts',
  'audio-worklet': 'src/audio-worklet.ts',
  'asr-worker': 'src/asr-worker.ts',
  'content-tunnel': 'src/content-tunnel.ts'
};

const manifest = {
  ...base,
  ...variant,
  version: packageJson.version,
  background: { service_worker: 'service-worker.js', type: 'module' },
  permissions: variant.permissions
};
```

`build.mjs` must remove only `dist/<channel>`, call esbuild with `bundle:true`, `format:'esm'`, `target:'chrome116'`, and copy the same HTML, CSS, icon, licenses, notices, WASM module, and WASM binary the current command copies. `package.mjs` zips only the requested channel into `release/Voice-VAC-Store-<version>.zip` or `release/Voice-VAC-Automation-<version>.zip`.

For this first green build, each new physical entry contains only `import './service-worker.js';`. Task 2 extracts their shared core; Tasks 8 and 9 inject different playback drivers.

- [ ] **Step 5: Replace the package scripts and update artifact tests**

```json
{
  "build": "npm run build:store",
  "build:store": "node scripts/build.mjs store",
  "build:automation": "node scripts/build.mjs automation",
  "build:all": "npm run build:store && npm run build:automation",
  "package:store": "node scripts/package.mjs store",
  "package:automation": "node scripts/package.mjs automation",
  "package:zip": "npm run package:store"
}
```

Update artifact paths from `dist/...` to `dist/store/...`, add equivalent Automation file assertions, and update identity tests to read both config variants.

- [ ] **Step 6: Run both builds and tests, then commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/manifest-variants.test.ts apps/chrome-extension/tests/manifest-identity.test.ts apps/chrome-extension/tests/extension-build-artifacts.test.ts
npm run build:all --workspace=@voivox/chrome-extension
git add apps/chrome-extension/config apps/chrome-extension/scripts apps/chrome-extension/package.json apps/chrome-extension/tests apps/chrome-extension/public/manifest.json
git commit -m "build: split Voice VAC Store and Automation extensions"
```

Expected: focused tests PASS; both `dist/store/manifest.json` and `dist/automation/manifest.json` exist; the retired single manifest is removed in the commit.

### Task 2: Enforce a physical Store source and byte boundary

**Files:**
- Create: `apps/chrome-extension/src/build-env.d.ts`
- Create: `apps/chrome-extension/src/build-channel.ts`
- Create: `apps/chrome-extension/src/service-worker-core.ts`
- Create: `apps/chrome-extension/src/service-worker.store.ts`
- Create: `apps/chrome-extension/src/service-worker.automation.ts`
- Create: `apps/chrome-extension/tests/store-boundary.test.ts`
- Modify: `apps/chrome-extension/scripts/build.mjs`
- Refactor: `apps/chrome-extension/src/service-worker.ts`

**Interfaces:**
- Consumes: current service-worker behavior.
- Produces: two separate dependency graphs and a build-time forbidden-byte gate.

- [ ] **Step 1: Write a failing source-graph and built-byte test**

```ts
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const forbidden = /chrome\.debugger|Runtime\.evaluate|Input\.dispatchMouseEvent|["']debugger["']/u;

describe('Store capability boundary', () => {
  it('contains no debugger permission or CDP bytes', async () => {
    const manifest = JSON.parse(await readFile(new URL('../dist/store/manifest.json', import.meta.url), 'utf8'));
    expect(manifest.permissions).not.toContain('debugger');
    for (const name of await readdir(new URL('../dist/store/', import.meta.url))) {
      if (!name.endsWith('.js')) continue;
      expect(await readFile(new URL(`../dist/store/${name}`, import.meta.url), 'utf8')).not.toMatch(forbidden);
    }
  });

  it('keeps Automation CDP code out of the Store composition root', async () => {
    const source = await readFile(new URL('../src/service-worker.store.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/automation|cdp|debugger/iu);
    expect(source).toContain("./service-worker-core.js");
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

```bash
cd voivox-workspace
npm run build:store --workspace=@voivox/chrome-extension
npm exec vitest -- run apps/chrome-extension/tests/store-boundary.test.ts
```

Expected: FAIL because the two service-worker composition roots and Store playback driver import do not exist.

- [ ] **Step 3: Extract the shared runtime without importing either driver**

```ts
export type ServiceWorkerRuntimeOptions = { channel: 'store' | 'automation' };

export function createServiceWorkerRuntime(options: ServiceWorkerRuntimeOptions): void {
  registerRuntimeMessages(options);
  registerTabLifecycle(options);
}
```

Move current message serialization, capture-state ownership, offscreen-document helpers, mode/retry behavior, and tunnel synchronization into focused functions under `service-worker-core.ts`. Keep `service-worker.ts` as a one-release compatibility re-export only if another test imports it; no built entry may reference it.

- [ ] **Step 4: Create independent composition roots**

```ts
// service-worker.store.ts
import { createServiceWorkerRuntime } from './service-worker-core.js';
createServiceWorkerRuntime({ channel: 'store' });
```

```ts
// service-worker.automation.ts
import { createServiceWorkerRuntime } from './service-worker-core.js';
createServiceWorkerRuntime({ channel: 'automation' });
```

Declare `__VOICE_VAC_CHANNEL__: 'store' | 'automation'` in `build-env.d.ts`; export `BUILD_CHANNEL` from `build-channel.ts`. The Store composition root must not import `build-channel.ts` if it would make a runtime conditional the only boundary.

- [ ] **Step 5: Make the build script fail closed**

After esbuild and copies complete, recursively inspect every Store `.js` file. Throw with the exact file and matched token if `chrome.debugger`, `Runtime.evaluate`, `Input.dispatchMouseEvent`, or a quoted `debugger` string occurs. For Automation, fail unless the manifest contains `debugger` and `service-worker.js` contains both `Runtime.evaluate` and `Input.dispatchMouseEvent` after Task 9.

Until Task 9, guard the reverse Automation assertion behind an exported `AUTOMATION_DRIVER_READY = false`; Task 9 changes it to `true` and removes that guard in the same green commit. Store checking is unconditional from this task onward.

- [ ] **Step 6: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/store-boundary.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts
npm run build:store --workspace=@voivox/chrome-extension
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src apps/chrome-extension/scripts/build.mjs apps/chrome-extension/tests/store-boundary.test.ts
git commit -m "refactor: isolate Store service worker capability graph"
```

Expected: Store boundary and existing service-worker reliability tests PASS; typecheck PASS.

### Task 3: Define the fixed target session and session-only persistence

**Files:**
- Create: `apps/chrome-extension/src/target-session.ts`
- Create: `apps/chrome-extension/src/target-session-store.ts`
- Create: `apps/chrome-extension/tests/target-session-store.test.ts`
- Modify: `apps/chrome-extension/src/bridge.ts`
- Modify: `apps/chrome-extension/tests/capture-state.test.ts`

**Interfaces:**
- Consumes: `chrome.storage.session` through a small injected `SessionStorage` interface.
- Produces: `TargetSession`, `VideoTarget`, `TargetSessionStore`, `validateSessionSender`, and expanded `CapturePhase`/`CaptureErrorCode` used by every subsequent task.

- [ ] **Step 1: Write failing persistence and sender-binding tests**

```ts
it('stores one armed document in session storage', async () => {
  const storage = memorySessionStorage();
  const store = new TargetSessionStore(storage);
  await store.save(armedSession({ tabId: 17, frameId: 0, documentId: 'doc-A' }));
  expect(await store.get()).toMatchObject({ tabId: 17, frameId: 0, documentId: 'doc-A' });
});

it('rejects the right tab with the wrong document', () => {
  const session = armedSession({ tabId: 17, frameId: 0, documentId: 'doc-A' });
  expect(validateSessionSender(session, {
    tab: { id: 17 }, frameId: 0, documentId: 'doc-B'
  } as chrome.runtime.MessageSender)).toBe(false);
});
```

Also test malformed stored data removal, `clearIfTab(17)`, and no use of `chrome.storage.local`.

- [ ] **Step 2: Run the tests and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/target-session-store.test.ts apps/chrome-extension/tests/capture-state.test.ts
```

Expected: FAIL because target session types/store and the expanded capture phases do not exist.

- [ ] **Step 3: Add the exact target and session types**

```ts
export type VideoTarget = {
  id: string;
  kind: 'html-media' | 'embedded-player' | 'tab-audio';
  tag?: 'video' | 'audio';
  frameId: number;
  documentId: string;
  viewportRect: { x: number; y: number; width: number; height: number };
  screenRect: { x: number; y: number; width: number; height: number };
  activationPoint: { x: number; y: number };
  canDirectPlay: boolean;
};

export type TargetSession = {
  schemaVersion: 1;
  id: string;
  tabId: number;
  windowId: number;
  frameId: number;
  documentId: string;
  pageOrigin: string;
  url: string;
  title: string;
  dropNonce: string;
  dropToken: string;
  status: 'armed' | 'dragging' | 'targeted' | 'ready' | 'awaiting-user-play' |
    'capturing' | 'paused' | 'transcribing' | 'completed' | 'error';
  target?: VideoTarget;
  armedAt: number;
  updatedAt: number;
  lastCommandId?: string;
  tunnelSessionId?: string;
};
```

- [ ] **Step 4: Implement strict session storage and sender validation**

```ts
const TARGET_SESSION_KEY = 'voiceVacTargetSession.v1';

type SessionStorage = Pick<chrome.storage.StorageArea, 'get' | 'set' | 'remove'>;

export class TargetSessionStore {
  constructor(private readonly storage: SessionStorage = chrome.storage.session) {}
  async get(): Promise<TargetSession | undefined> {
    const value = (await this.storage.get(TARGET_SESSION_KEY))[TARGET_SESSION_KEY];
    if (!isTargetSession(value)) {
      if (value !== undefined) await this.storage.remove(TARGET_SESSION_KEY);
      return undefined;
    }
    return structuredClone(value);
  }
  async save(session: TargetSession): Promise<void> {
    if (!isTargetSession(session)) throw new Error('Invalid Voice VAC target session.');
    await this.storage.set({ [TARGET_SESSION_KEY]: structuredClone(session) });
  }
  async update(id: string, patch: TargetSessionPatch): Promise<TargetSession> {
    const current = await this.get();
    if (!current || current.id !== id) throw new Error('Voice VAC target session changed.');
    const next = { ...current, ...structuredClone(patch), updatedAt: Date.now() };
    await this.save(next);
    return next;
  }
  async clear(): Promise<void> {
    await this.storage.remove(TARGET_SESSION_KEY);
  }
  async clearIfTab(tabId: number): Promise<boolean> {
    const current = await this.get();
    if (!current || current.tabId !== tabId) return false;
    await this.clear();
    return true;
  }
}

export function validateSessionSender(session: TargetSession, sender: chrome.runtime.MessageSender): boolean {
  return sender.tab?.id === session.tabId
    && sender.frameId === session.frameId
    && sender.documentId === session.documentId;
}
```

`TargetSessionPatch` must omit `schemaVersion`, `id`, `tabId`, `windowId`, `frameId`, `documentId`, `dropNonce`, `dropToken`, and `armedAt` so later code cannot retarget an existing session.

`isTargetSession` must require schema version 1; UUID `id`; non-negative integer tab/window/frame IDs; non-empty document ID, origin, URL, title, nonce, and token; finite timestamps; a status from the closed union; and a structurally valid optional target. No coercion is permitted.

- [ ] **Step 5: Expand capture state without removing ASR phases**

`CaptureState.phase` becomes:

```ts
export type CapturePhase = 'idle' | 'armed' | 'connecting' | 'awaiting-user-play' |
  'capturing' | 'paused' | 'downloading' | 'transcribing' | 'complete' | 'error';
```

Keep current download/transcription compatibility fields and normalize unknown states to `idle`. Do not persist `tabId` in `CaptureState`; the target session is its only authority.

- [ ] **Step 6: Run tests, typecheck, and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/target-session-store.test.ts apps/chrome-extension/tests/capture-state.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/target-session.ts apps/chrome-extension/src/target-session-store.ts apps/chrome-extension/src/bridge.ts apps/chrome-extension/tests
git commit -m "feat: bind Voice VAC targets to session documents"
```

### Task 4: Arm one Chrome document and invalidate it on navigation or close

**Files:**
- Create: `apps/chrome-extension/src/tab-arm.ts`
- Create: `apps/chrome-extension/tests/tab-arm.test.ts`
- Modify: `apps/chrome-extension/src/service-worker-core.ts`
- Modify: `apps/chrome-extension/src/popup.ts`
- Modify: `apps/chrome-extension/src/tunnel-session-sync.ts`
- Modify: `apps/chrome-extension/tests/tunnel-session-sync.test.ts`
- Modify: `apps/chrome-extension/tests/service-worker-reliability.test.ts`
- Modify: `packages/core/src/cross-window-session.ts`
- Modify: `packages/core/tests/cross-window-session.test.ts`

**Interfaces:**
- Consumes: `TargetSessionStore`; uses the exact private token formatter below until Task 5 extracts it without changing output.
- Produces: `armActiveTab(deps): Promise<TargetSession>`, `registerTargetLifecycle(deps): void`, and the `tab:arm` message.

- [ ] **Step 1: Write a failing test proving active-tab lookup happens only while arming**

```ts
it('keeps the armed tab after another tab becomes active', async () => {
  const harness = createTabArmHarness({
    activeTab: { id: 41, windowId: 3, title: 'Target', url: 'https://video.example/watch' },
    injection: { documentId: 'doc-41', frameId: 0 }
  });
  const session = await armActiveTab(harness.dependencies);
  harness.setActiveTab({ id: 99, windowId: 3, title: 'Other', url: 'https://other.example' });

  expect(session).toMatchObject({ tabId: 41, documentId: 'doc-41', status: 'armed' });
  expect((await harness.sessionStore.get())?.tabId).toBe(41);
  expect(harness.queryCalls()).toBe(1);
});
```

Add tests that no active tab returns `TAB_NOT_ARMED`, a missing injection `documentId` fails closed, `tabs.onRemoved(41)` clears the session, `tabs.onUpdated(41,{status:'loading'})` clears it, and events for tab 99 do nothing.

- [ ] **Step 2: Run the test and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/tab-arm.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts
```

Expected: FAIL because `tab-arm.ts`, `tab:arm`, and fixed-session lifecycle handlers do not exist.

- [ ] **Step 3: Implement `armActiveTab` as the sole active-tab query**

```ts
export async function armActiveTab(deps: TabArmDependencies): Promise<TargetSession> {
  const [tab] = await deps.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.windowId === undefined || !tab.url) {
    throw captureError('TAB_NOT_ARMED');
  }
  const [injection] = await deps.scripting.executeScript({
    files: ['content-tunnel.js'],
    target: { tabId: tab.id, frameIds: [0] }
  });
  if (!injection?.documentId || injection.frameId !== 0) {
    throw captureError('TARGET_NAVIGATED');
  }
  const id = deps.randomUUID();
  const nonce = deps.randomNonce();
  const session = createArmedSession({ id, nonce, tab, documentId: injection.documentId });
  await deps.sessionStore.save(session);
  await deps.tabs.sendMessage(tab.id, { type: 'session:armed', session }, { documentId: session.documentId });
  return session;
}
```

`randomNonce()` must use 32 random bytes and base64url encoding. The arm action must not call `tabCapture`, `HTMLMediaElement.play`, or create the offscreen document.

Use this exact formatter in `tab-arm.ts` for the first green commit:

```ts
function formatArmedDropToken(sessionId: string, nonce: string): string {
  return `VOICE_VAC_DROP_V1|${sessionId}|${nonce}`;
}
```

Extend `CrossWindowSession` and its strict create validator with `frameId`, `documentId`, and `dropToken`. `syncTunnelSession` sends those values only when creating the bridge session. The native App reads the primary-token tunnel-session view and places the exact `dropToken` on `NSPasteboard`. Tests must prove later PATCH requests cannot change `tabId`, `frameId`, `documentId`, or `dropToken`.

- [ ] **Step 4: Replace popup overlay invocation with arming**

```ts
const armed = await chrome.runtime.sendMessage({
  target: 'service-worker',
  type: 'tab:arm'
});
captureState = normalizeCaptureState(armed.captureState);
```

The popup still renders transcript/mode controls, but initial invocation arms the selected document and closes without starting capture. Replace `capture:toggle` UI dispatch with explicit state-derived commands in Task 11.

- [ ] **Step 5: Add deterministic tab lifecycle cleanup**

```ts
chrome.tabs.onRemoved.addListener((tabId) => void lifecycle.invalidateTab(tabId, 'TAB_CLOSED'));
chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => void lifecycle.invalidateTab(removedTabId, 'TARGET_NAVIGATED'));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || typeof changeInfo.url === 'string') {
    void lifecycle.invalidateTab(tabId, 'TARGET_NAVIGATED');
  }
});
```

Invalidation stops any track, disposes the active playback driver, publishes the stable error, clears the session, and never arms the newly active tab automatically.

- [ ] **Step 6: Run tests and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/tab-arm.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts apps/chrome-extension/tests/tunnel-session-sync.test.ts packages/core/tests/cross-window-session.test.ts apps/chrome-extension/tests/content-tunnel.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src apps/chrome-extension/tests packages/core/src/cross-window-session.ts packages/core/tests/cross-window-session.test.ts
git commit -m "feat: arm and retain one Chrome target document"
```

Expected: changing active tabs cannot change the stored target; all lifecycle tests PASS.

### Task 5: Parse authenticated external drops and resolve a video target

**Files:**
- Create: `apps/chrome-extension/src/drop-protocol.ts`
- Create: `apps/chrome-extension/src/video-target.ts`
- Create: `apps/chrome-extension/tests/drop-protocol.test.ts`
- Create: `apps/chrome-extension/tests/video-target.test.ts`
- Modify: `apps/chrome-extension/src/tab-arm.ts`

**Interfaces:**
- Consumes: `TargetSession.dropNonce` and `TargetSession.dropToken`.
- Produces: `formatDropToken`, `parseDropToken`, `matchesDropToken`, `screenRectFromDrop`, and `resolveVideoTarget`.

- [ ] **Step 1: Write failing token tests**

```ts
describe('external drop protocol', () => {
  const token = 'VOICE_VAC_DROP_V1|2b0fe529-4021-4674-b55e-1cf081f947dd|AbCdEf0123_-';

  it('round-trips only the exact version-one plain text token', () => {
    expect(parseDropToken(token)).toEqual({
      protocolVersion: 1,
      sessionId: '2b0fe529-4021-4674-b55e-1cf081f947dd',
      nonce: 'AbCdEf0123_-'
    });
    expect(parseDropToken(`${token}\n`)).toBeUndefined();
    expect(parseDropToken('https://example.com')).toBeUndefined();
    expect(parseDropToken('VOICE_VAC_DROP_V2|x|y')).toBeUndefined();
  });
});
```

Test a 43-character base64url nonce, exact UUID, extra separators, Unicode lookalikes, whitespace, and wrong session/nonce rejection.

- [ ] **Step 2: Write failing target and coordinate tests**

```ts
it('derives screen coordinates from the trusted drop event', () => {
  expect(screenRectFromDrop(
    { clientX: 300, clientY: 200, screenX: 1300, screenY: 700 },
    { x: 40, y: 20, width: 640, height: 360 }
  )).toEqual({ x: 1040, y: 520, width: 640, height: 360 });
});

it('prefers visible media, then embedded player, then tab audio', () => {
  expect(resolveVideoTarget(mediaFixture()).kind).toBe('html-media');
  expect(resolveVideoTarget(iframeFixture()).kind).toBe('embedded-player');
  expect(resolveVideoTarget(customPlayerFixture()).kind).toBe('tab-audio');
});
```

- [ ] **Step 3: Run both tests and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/drop-protocol.test.ts apps/chrome-extension/tests/video-target.test.ts
```

Expected: FAIL because the protocol and target modules do not exist.

- [ ] **Step 4: Implement the exact token protocol**

```ts
const TOKEN_PATTERN = /^VOICE_VAC_DROP_V1\|([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\|([A-Za-z0-9_-]{43})$/u;

export function formatDropToken(sessionId: string, nonce: string): string {
  const token = `VOICE_VAC_DROP_V1|${sessionId}|${nonce}`;
  if (!TOKEN_PATTERN.test(token)) throw new Error('Invalid Voice VAC drop identity.');
  return token;
}
```

Use a constant-time byte comparison for the supplied nonce after parsing. Never accept `text/uri-list` or treat the token as navigation data.

- [ ] **Step 5: Implement deterministic target resolution**

```ts
export function screenRectFromDrop(event: DropCoordinates, rect: Rect): Rect {
  return {
    x: event.screenX - event.clientX + rect.x,
    y: event.screenY - event.clientY + rect.y,
    width: rect.width,
    height: rect.height
  };
}
```

`resolveVideoTarget` receives an injected `elementsFromPoint` result so unit tests use real resolution logic without mocking private functions. Skip Voice VAC overlay nodes, reject zero-area/hidden media, prefer the first visible `video` or `audio`, select an iframe/embed/object as `embedded-player`, and classify a visible custom-player container with media semantics as `tab-audio`. Return `undefined` on an ordinary empty page. For direct media, assign `data-voice-vac-target-id=<random UUID>` and set `canDirectPlay=true`. Use the main-frame document ID supplied by the armed session for every fallback.

- [ ] **Step 6: Replace the temporary arm token and verify**

Use `formatDropToken(id, nonce)` in `tab-arm.ts`, then run:

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/drop-protocol.test.ts apps/chrome-extension/tests/video-target.test.ts apps/chrome-extension/tests/tab-arm.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/drop-protocol.ts apps/chrome-extension/src/video-target.ts apps/chrome-extension/src/tab-arm.ts apps/chrome-extension/tests
git commit -m "feat: authenticate native drops and resolve page targets"
```

### Task 6: Replace the in-page machine with the armed drop/target overlay

**Files:**
- Modify: `apps/chrome-extension/src/content-tunnel.ts`
- Modify: `apps/chrome-extension/public/content-tunnel.css`
- Modify: `apps/chrome-extension/tests/content-tunnel.test.ts`

**Interfaces:**
- Consumes: `session:armed`, `drag:begin`, `drag:cancel`, exact drop tokens, and `resolveVideoTarget`.
- Produces: `target:preview`, `target:ready`, `target:rejected`, `playback:user-started`, and page overlay cleanup.

- [ ] **Step 1: Replace the old machine tests with failing external-drop tests**

```ts
it('accepts one trusted drop only while the matching session is dragging', async () => {
  const tunnel = mountContentTunnel({ sendMessage, document, window });
  tunnel.configure(armedSession);
  tunnel.beginDrag({ sessionId: armedSession.id, dropToken: armedSession.dropToken });

  const event = dropEvent({
    trusted: true,
    text: armedSession.dropToken,
    clientX: 240, clientY: 180,
    screenX: 1240, screenY: 680
  });
  document.dispatchEvent(event);

  expect(event.defaultPrevented).toBe(true);
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: 'target:ready',
    sessionId: armedSession.id,
    target: expect.objectContaining({ kind: 'html-media' })
  }));
});
```

Add separate tests proving an untrusted event, wrong token, wrong session, or no `drag:begin` is ignored without `preventDefault`; an invalid location sends `target:rejected` and leaves the target overlay deployed; destroy/navigation removes the target attribute and outline.

- [ ] **Step 2: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/content-tunnel.test.ts
```

Expected: FAIL because current content script draws a large page-local machine, accepts pointer drag without a token, and approximates screen coordinates with `window.screenX`.

- [ ] **Step 3: Implement a top-frame full-viewport drop catcher**

```ts
function onDrop(event: DragEvent): void {
  if (!dragContext || !event.isTrusted) return;
  const supplied = event.dataTransfer?.getData('text/plain') ?? '';
  if (!matchesDropToken(dragContext.session, supplied)) return;
  event.preventDefault();
  const target = resolveVideoTarget({
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    documentId: dragContext.session.documentId,
    frameId: 0,
    elements: elementsBelowOverlay(event.clientX, event.clientY)
  });
  publishResolvedTarget(target);
}
```

Mount only in `window.top === window`. During an armed native drag, display a transparent viewport overlay with candidate outline; outside that bounded interval, set `pointer-events:none`. Do not restore the old page-local capsule, hose, transcript, copy button, or primary button.

- [ ] **Step 4: Implement preview, ready, warning, and cleanup semantics**

`dragover` may call `preventDefault` only when the data transfer advertises `text/plain` and an armed drag context is active; the token is validated at `drop`. A successful direct target is highlighted and sent as `target:ready`; tab-audio fallback is sent as `target:ready` with a visible embedded-player warning; a truly unusable page sends `target:rejected` with `NO_PLAYABLE_MEDIA` and keeps the overlay available for another drag. The `target-disconnect` message removes all attributes, outlines, prompts, and event handlers.

- [ ] **Step 5: Keep the CSS limited to page affordances**

The stylesheet may define only:

```css
.voice-vac-drop-catcher { position: fixed; inset: 0; z-index: 2147483647; }
.voice-vac-target-outline { outline: 3px solid rgb(166 210 229 / 92%); outline-offset: 4px; }
.voice-vac-play-prompt { position: fixed; pointer-events: auto; }
```

Remove all `.vacvox-machine`, plaque, hose, output, and page capsule selectors.

- [ ] **Step 6: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/content-tunnel.test.ts apps/chrome-extension/tests/video-target.test.ts apps/chrome-extension/tests/drop-protocol.test.ts
npm run build:store --workspace=@voivox/chrome-extension
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/content-tunnel.ts apps/chrome-extension/public/content-tunnel.css apps/chrome-extension/tests/content-tunnel.test.ts
git commit -m "feat: add trusted cross-window target drop overlay"
```

### Task 7: Centralize stable capture errors and explicit command semantics

**Files:**
- Create: `apps/chrome-extension/src/capture-errors.ts`
- Create: `apps/chrome-extension/tests/capture-errors.test.ts`
- Modify: `apps/chrome-extension/src/bridge.ts`
- Modify: `apps/chrome-extension/src/popup-presentation.ts`
- Modify: `apps/chrome-extension/tests/popup-presentation.test.ts`

**Interfaces:**
- Produces: `CaptureErrorCode`, `CaptureFailure`, `captureError(code, detail?)`, `captureCommandForState(state)`.
- Consumers: arm lifecycle, Store driver, CDP driver, capture controller, native command channel, popup, App bridge.

- [ ] **Step 1: Write failing error-catalog tests**

```ts
it.each([
  ['TAB_NOT_ARMED', 'Click the Voice VAC extension on this tab to arm it.'],
  ['NO_PLAYABLE_MEDIA', 'No playable video found here.'],
  ['USER_PLAY_REQUIRED', 'Press play once in Chrome.'],
  ['EMBEDDED_PLAYER_CLICK_REQUIRED', 'This embedded player needs one click to start.'],
  ['TAB_FROZEN', 'This tab is asleep. Bring it forward to continue.'],
  ['TARGET_NAVIGATED', 'The page changed. Arm this tab again.']
] as const)('maps %s to stable English copy', (code, message) => {
  expect(captureError(code)).toMatchObject({ code, message });
});

it('never serializes an empty message', () => {
  for (const code of CAPTURE_ERROR_CODES) expect(captureError(code).message.trim()).not.toBe('');
});
```

Also assert recoverability: `USER_PLAY_REQUIRED` and `TAB_FROZEN` are recoverable; `TARGET_NAVIGATED`, `TAB_CLOSED`, and `STREAM_ID_EXPIRED` require re-arm/restart.

- [ ] **Step 2: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/capture-errors.test.ts apps/chrome-extension/tests/popup-presentation.test.ts
```

Expected: FAIL because the catalog and explicit command selector do not exist.

- [ ] **Step 3: Implement the closed error union and metadata**

```ts
export const CAPTURE_ERROR_CODES = [
  'TAB_NOT_ARMED', 'NO_PLAYABLE_MEDIA', 'USER_PLAY_REQUIRED',
  'EMBEDDED_PLAYER_CLICK_REQUIRED', 'CROSS_ORIGIN_PLAYER', 'TAB_FROZEN',
  'TARGET_NAVIGATED', 'CAPTURE_DENIED', 'STREAM_ID_EXPIRED', 'STREAM_ENDED',
  'TAB_CLOSED', 'NATIVE_HOST_UNAVAILABLE', 'DEBUGGER_ATTACH_FAILED',
  'DEBUGGER_DETACHED', 'NO_AUDIO_AFTER_TIMEOUT', 'TRANSCRIPTION_CANCELLED',
  'TRANSCRIPTION_TIMEOUT'
] as const;

export type CaptureFailure = {
  code: CaptureErrorCode;
  message: string;
  severity: 'warning' | 'error';
  recovery: 'retry' | 'user-play' | 'bring-forward' | 're-arm' | 'restart';
};
```

The catalog stores English source copy. UI translation maps by code only after the user chooses Chinese. Preserve compatibility normalization from old lowercase transcription codes to the uppercase forms.

- [ ] **Step 4: Replace toggle presentation with explicit commands**

```ts
export type CaptureCommandType = 'capture-start' | 'capture-pause' |
  'capture-resume' | 'capture-stop';

export function captureCommandForState(state: CaptureState): CaptureCommandType {
  if (state.phase === 'capturing') return 'capture-pause';
  if (state.phase === 'paused') return 'capture-resume';
  if (state.phase === 'transcribing' || state.phase === 'downloading') return 'capture-stop';
  return 'capture-start';
}
```

Keep Retry as a separate ASR retry action. The popup button label and icon derive from this function, not from `active` alone.

- [ ] **Step 5: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/capture-errors.test.ts apps/chrome-extension/tests/popup-presentation.test.ts apps/chrome-extension/tests/capture-state.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/capture-errors.ts apps/chrome-extension/src/bridge.ts apps/chrome-extension/src/popup-presentation.ts apps/chrome-extension/tests
git commit -m "feat: add stable Voice VAC capture errors and commands"
```

### Task 8: Implement Store playback with a trusted-click fallback

**Files:**
- Create: `apps/chrome-extension/src/playback-driver.ts`
- Create: `apps/chrome-extension/src/store-playback-driver.ts`
- Create: `apps/chrome-extension/tests/store-playback-driver.test.ts`
- Modify: `apps/chrome-extension/src/content-tunnel.ts`
- Modify: `apps/chrome-extension/public/content-tunnel.css`
- Modify: `apps/chrome-extension/src/service-worker.store.ts`
- Modify: `apps/chrome-extension/src/service-worker-core.ts`
- Modify: `apps/chrome-extension/tests/content-tunnel.test.ts`

**Interfaces:**
- Produces: `PlaybackDriver`, `PlaybackResult`, and `StorePlaybackDriver`.
- Consumes: exact `TargetSession.tabId`, `.documentId`, `.target.id`, and a content-script `playback:play|pause` response.

- [ ] **Step 1: Write failing driver tests**

```ts
it('addresses the armed document instead of the active tab', async () => {
  const send = vi.fn().mockResolvedValue({ status: 'playing' });
  const driver = new StorePlaybackDriver({ send });
  const result = await driver.play(readySession({ tabId: 41, documentId: 'doc-41' }));

  expect(send).toHaveBeenCalledWith(41, {
    target: 'content-tunnel', type: 'playback:play',
    sessionId: expect.any(String), targetId: expect.any(String)
  }, { documentId: 'doc-41', frameId: 0 });
  expect(result).toEqual({ status: 'playing' });
});

it('maps page autoplay rejection to user play required', async () => {
  const driver = new StorePlaybackDriver({
    send: vi.fn().mockResolvedValue({ status: 'user-play-required' })
  });
  await expect(driver.play(readySession())).resolves.toEqual({
    status: 'user-play-required', code: 'USER_PLAY_REQUIRED'
  });
});
```

Add tests for missing direct target, embedded player, document-not-found runtime error, and exact pause addressing.

- [ ] **Step 2: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/store-playback-driver.test.ts apps/chrome-extension/tests/content-tunnel.test.ts
```

Expected: FAIL because driver types and playback messages do not exist.

- [ ] **Step 3: Define and implement the driver contract**

```ts
export type PlaybackResult =
  | { status: 'playing' }
  | { status: 'user-play-required'; code: 'USER_PLAY_REQUIRED' | 'EMBEDDED_PLAYER_CLICK_REQUIRED' }
  | { status: 'failed'; code: CaptureErrorCode };

export interface PlaybackDriver {
  play(session: TargetSession): Promise<PlaybackResult>;
  pause(session: TargetSession): Promise<void>;
  dispose(tabId: number): Promise<void>;
}
```

`StorePlaybackDriver.play` returns `EMBEDDED_PLAYER_CLICK_REQUIRED` for `embedded-player`, sends to the stored tab/document for `html-media`, and returns `USER_PLAY_REQUIRED` for `tab-audio`. It never calls `chrome.tabs.query` or `chrome.scripting.executeScript`.

- [ ] **Step 4: Implement page playback without synthetic clicks**

```ts
async function playTarget(targetId: string): Promise<PlaybackResult> {
  const media = [...document.querySelectorAll<HTMLMediaElement>('video,audio')]
    .find((element) => element.dataset.voiceVacTargetId === targetId);
  if (!media) return { status: 'failed', code: 'TARGET_NAVIGATED' };
  try {
    await media.play();
    return { status: 'playing' };
  } catch (error) {
    return error instanceof DOMException && error.name === 'NotAllowedError'
      ? { status: 'user-play-required', code: 'USER_PLAY_REQUIRED' }
      : { status: 'failed', code: 'NO_PLAYABLE_MEDIA' };
  }
}
```

Do not call `media.click()`. When user play is required, show a small page prompt with exactly `Press play once in Chrome.`. Install a one-shot capture-phase document `click` listener; only `event.isTrusted` may send `playback:user-started`. The prompt must not cover the actual player control.

- [ ] **Step 5: Inject Store driver at its physical composition root**

```ts
createServiceWorkerRuntime({
  channel: 'store',
  playbackDriver: new StorePlaybackDriver()
});
```

Change `ServiceWorkerRuntimeOptions.playbackDriver` from absent to required. Until Task 9 replaces it, the Automation composition root injects the same `StorePlaybackDriver`; its manifest already requires `debugger`, but it does not claim automated playback before the CDP driver is green.

- [ ] **Step 6: Verify Store boundary and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/store-playback-driver.test.ts apps/chrome-extension/tests/content-tunnel.test.ts apps/chrome-extension/tests/store-boundary.test.ts
npm run build:store --workspace=@voivox/chrome-extension
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src apps/chrome-extension/public/content-tunnel.css apps/chrome-extension/tests
git commit -m "feat: add Store media playback and trusted click fallback"
```

Expected: all focused tests PASS and byte scanning still reports zero Store debugger/CDP bytes.

### Task 9: Implement the required Automation CDP playback driver

**Files:**
- Create: `apps/chrome-extension/src/automation/cdp-playback-driver.ts`
- Create: `apps/chrome-extension/tests/cdp-playback-driver.test.ts`
- Modify: `apps/chrome-extension/src/service-worker.automation.ts`
- Modify: `apps/chrome-extension/scripts/build.mjs`
- Modify: `apps/chrome-extension/tests/store-boundary.test.ts`

**Interfaces:**
- Consumes: `PlaybackDriver`, exact target session, injected `chrome.debugger` API.
- Produces: `CdpPlaybackDriver`, one attached-tab set, and deterministic detach cleanup.

- [ ] **Step 1: Write failing direct-media CDP tests**

```ts
it('plays direct media inside the armed page with a CDP user gesture', async () => {
  const api = debuggerHarness();
  const driver = new CdpPlaybackDriver({ api });
  await driver.play(readySession({ tabId: 41, targetKind: 'html-media' }));

  expect(api.attach).toHaveBeenCalledWith({ tabId: 41 }, '1.3');
  expect(api.sendCommand).toHaveBeenCalledWith(
    { tabId: 41 }, 'Runtime.evaluate',
    expect.objectContaining({ awaitPromise: true, returnByValue: true, userGesture: true })
  );
});
```

- [ ] **Step 2: Write failing embedded-player and focus-safety tests**

```ts
it('dispatches one internal click without activating or focusing the target', async () => {
  const api = debuggerHarness();
  const driver = new CdpPlaybackDriver({ api });
  await driver.play(readySession({ tabId: 41, targetKind: 'embedded-player', point: { x: 640, y: 360 } }));

  expect(api.commandNames()).toEqual([
    'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent'
  ]);
  expect(api.commandParameters()).toEqual([
    expect.objectContaining({ type: 'mouseMoved', x: 640, y: 360 }),
    expect.objectContaining({ type: 'mousePressed', button: 'left', clickCount: 1 }),
    expect.objectContaining({ type: 'mouseReleased', button: 'left', clickCount: 1 })
  ]);
  expect(api.commandNames()).not.toContain('Page.bringToFront');
  expect(api.commandNames()).not.toContain('Target.activateTarget');
});
```

Also test attach failure -> `DEBUGGER_ATTACH_FAILED`, external `onDetach` -> `DEBUGGER_DETACHED`, repeated play attaches once, and stop/disconnect disposes exactly once.

- [ ] **Step 3: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/cdp-playback-driver.test.ts apps/chrome-extension/tests/store-boundary.test.ts
```

Expected: FAIL because the Automation driver does not exist and Automation output lacks CDP commands.

- [ ] **Step 4: Implement direct media evaluation**

Build an expression with `JSON.stringify(session.target.id)` rather than interpolating unescaped text:

```ts
const expression = `(() => {
  const id = ${JSON.stringify(session.target.id)};
  const media = [...document.querySelectorAll('video,audio')]
    .find((node) => node.getAttribute('data-voice-vac-target-id') === id);
  if (!media) return { status: 'failed', code: 'TARGET_NAVIGATED' };
  return media.play().then(
    () => ({ status: 'playing' }),
    () => ({ status: 'failed', code: 'NO_PLAYABLE_MEDIA' })
  );
})()`;
```

Send `Runtime.evaluate` with `awaitPromise:true`, `returnByValue:true`, and `userGesture:true`. Validate the returned value against `PlaybackResult`; never trust arbitrary remote object fields.

- [ ] **Step 5: Implement embedded click and lifecycle disposal**

Attach only on `play`, never on install, arm, or drop. Send `mouseMoved`, `mousePressed`, `mouseReleased` with the exact main-frame CSS activation point. Maintain `Set<number> attachedTabs`; `pause` uses `Runtime.evaluate` to call `.pause()` only for direct media; `dispose(tabId)` detaches and deletes the set entry. Register one `chrome.debugger.onDetach` listener and map unexpected detaches for an active target to `DEBUGGER_DETACHED`.

- [ ] **Step 6: Make Automation CDP verification unconditional**

Delete the temporary `AUTOMATION_DRIVER_READY` gate. `build.mjs` must now fail unless:

```js
automationManifest.permissions.includes('debugger')
  && automationWorker.includes('Runtime.evaluate')
  && automationWorker.includes('Input.dispatchMouseEvent')
```

It must still fail Store builds on any forbidden token.

- [ ] **Step 7: Inject the real driver, build both channels, and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/cdp-playback-driver.test.ts apps/chrome-extension/tests/store-boundary.test.ts apps/chrome-extension/tests/manifest-variants.test.ts
npm run build:all --workspace=@voivox/chrome-extension
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/automation apps/chrome-extension/src/service-worker.automation.ts apps/chrome-extension/scripts/build.mjs apps/chrome-extension/tests
git commit -m "feat: add isolated Automation CDP playback driver"
```

Expected: Automation contains required debugger/CDP capability; Store remains byte-clean.

### Task 10: Add pause/resume and stop/flush semantics to the offscreen capture owner

**Files:**
- Modify: `apps/chrome-extension/src/offscreen.ts`
- Modify: `apps/chrome-extension/tests/offscreen-reliability.test.ts`
- Modify: `apps/chrome-extension/src/captured-audio.ts`
- Modify: `apps/chrome-extension/tests/captured-audio.test.ts`

**Interfaces:**
- Consumes messages: `audio:start`, `audio:pause`, `audio:resume`, `audio:stop`, `audio:discard`, `audio:cancel`, `audio:retry`.
- Produces acknowledgements `{ state }` and never appends PCM while paused.

- [ ] **Step 1: Write failing pause/resume tests**

```ts
it('suspends the audio graph and rejects samples while paused', async () => {
  const harness = await createOffscreenHarness();
  await harness.dispatch({ target: 'offscreen', type: 'audio:start', ...startMessage });
  harness.pushSamples(new Float32Array([0.3, -0.2]));
  const beforePause = harness.bufferedSampleCount();

  const paused = await harness.dispatch({ target: 'offscreen', type: 'audio:pause' });
  harness.pushSamples(new Float32Array([0.7, 0.8]));

  expect(harness.audioContext.suspend).toHaveBeenCalledOnce();
  expect(harness.bufferedSampleCount()).toBe(beforePause);
  expect(paused.state.phase).toBe('paused');
});

it('resumes the same stream without clearing buffered audio', async () => {
  const harness = await createOffscreenHarness();
  await harness.startAndPause();
  const samples = harness.bufferedSampleCount();
  const resumed = await harness.dispatch({ target: 'offscreen', type: 'audio:resume' });
  expect(harness.audioContext.resume).toHaveBeenCalled();
  expect(harness.bufferedSampleCount()).toBe(samples);
  expect(resumed.state.phase).toBe('capturing');
});
```

Add tests that stop from paused closes tracks and starts transcription, cancel during transcription keeps retryable audio, and a track-ended event emits `STREAM_ENDED` rather than a blank error.

Add a separate `audio:discard` test proving it stops tracks, clears PCM, resets the graph, and returns `idle` without invoking ASR; this is used only when playback never begins.

- [ ] **Step 2: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/offscreen-reliability.test.ts apps/chrome-extension/tests/captured-audio.test.ts
```

Expected: FAIL because `audio:pause`, `audio:resume`, and paused sample rejection do not exist.

- [ ] **Step 3: Add one explicit paused flag and message handlers**

```ts
let capturePaused = false;

if (message.type === 'audio:pause') {
  void serializeCaptureOperation(pauseCapture).then((state) => sendResponse({ state }));
  return true;
}
if (message.type === 'audio:resume') {
  void serializeCaptureOperation(resumeCapture).then((state) => sendResponse({ state }));
  return true;
}
```

`pauseCapture` requires an active stream, calls `audioContext.suspend()`, sets `capturePaused=true`, and saves phase `paused`. `resumeCapture` requires the same active stream, calls `audioContext.resume()`, clears the flag, and saves phase `capturing`. `startCapture`, `stopCapture`, `releaseAudioGraph`, and error cleanup reset the flag.

- [ ] **Step 4: Gate the PCM queue and preserve stop/flush**

```ts
function queueAudio(samples: Float32Array, sourceRate: number, generation: number): void {
  if (generation !== captureGeneration || capturePaused) return;
  const resampled = downsampler.resample(samples, sourceRate);
  if (route !== 'browser-local') return;
  const accepted = capturedBrowserAudio.append(resampled);
  if (!accepted && !captureLimitReached) stopAtCaptureLimit();
}
```

`audio:stop` from capturing or paused always stops tracks, closes the graph, preserves the current buffer, moves to `transcribing`, and runs ASR. If the buffer is silent, return `NO_AUDIO_AFTER_TIMEOUT` with English copy and `canRetry:false`.

`audio:discard` calls `releaseAudioGraph()`, clears `CapturedAudio` and the downsampler, resets route/session fields, and saves `idle`; it never calls `runBrowserTranscription()`.

- [ ] **Step 5: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/offscreen-reliability.test.ts apps/chrome-extension/tests/captured-audio.test.ts apps/chrome-extension/tests/browser-transcriber.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/offscreen.ts apps/chrome-extension/src/captured-audio.ts apps/chrome-extension/tests
git commit -m "feat: pause and resume fixed-tab audio capture"
```

### Task 11: Drive capture from the stored session with explicit commands

**Files:**
- Create: `apps/chrome-extension/src/capture-controller.ts`
- Create: `apps/chrome-extension/tests/capture-controller.test.ts`
- Modify: `apps/chrome-extension/src/service-worker-core.ts`
- Modify: `apps/chrome-extension/src/popup.ts`
- Modify: `apps/chrome-extension/tests/service-worker-reliability.test.ts`

**Interfaces:**
- Consumes: `TargetSessionStore`, `PlaybackDriver`, offscreen messenger, `chrome.tabCapture.getMediaStreamId`.
- Produces: `CaptureController.execute({ commandId, sessionId, type })` for popup and Native Messaging.

- [ ] **Step 1: Write a failing fixed-tab start test**

```ts
it('captures the stored tab even when another tab is active', async () => {
  const harness = captureControllerHarness({
    session: readySession({ tabId: 41, documentId: 'doc-41' }),
    currentlyActiveTabId: 99
  });
  await harness.controller.execute(command('capture-start'));

  expect(harness.tabsQuery).not.toHaveBeenCalled();
  expect(harness.getMediaStreamId).toHaveBeenCalledWith({ targetTabId: 41 });
  expect(harness.offscreenMessages[0]).toMatchObject({ type: 'audio:start' });
  expect(harness.playback.play).toHaveBeenCalledWith(expect.objectContaining({ tabId: 41 }));
});
```

- [ ] **Step 2: Add failing state, order, and idempotency tests**

```ts
it('consumes the stream before attempting playback', async () => {
  const events: string[] = [];
  const harness = captureControllerHarness({ events });
  await harness.controller.execute(command('capture-start'));
  expect(events).toEqual(['stream-id', 'offscreen-start', 'playback-play']);
});

it('deduplicates a repeated native command id', async () => {
  const harness = captureControllerHarness();
  const input = command('capture-start', { commandId: 'cmd-1' });
  await harness.controller.execute(input);
  await harness.controller.execute(input);
  expect(harness.getMediaStreamId).toHaveBeenCalledOnce();
});
```

Also cover: only `ready` may start; discarded/frozen tab -> `TAB_FROZEN`; expired stream ID -> `STREAM_ID_EXPIRED`; Store fallback -> `awaiting-user-play`; trusted click within 60 seconds -> `capturing`; timeout -> close stream and `USER_PLAY_REQUIRED`; pause/resume/stop transitions; stop always disposes the playback driver.

- [ ] **Step 3: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/capture-controller.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts
```

Expected: FAIL because capture still queries the current active tab and uses `capture:toggle`.

- [ ] **Step 4: Implement the controller with injected dependencies**

```ts
export type CaptureCommand = {
  protocolVersion: 2;
  commandId: string;
  sessionId: string;
  type: 'capture-start' | 'capture-pause' | 'capture-resume' |
    'capture-stop' | 'target-disconnect';
  issuedAt: number;
};

export class CaptureController {
  async execute(command: CaptureCommand): Promise<CaptureState> {
    const session = await this.sessions.require(command.sessionId);
    if (session.lastCommandId === command.commandId) return this.captureStates.get();
    const state = await this.executeOnce(session, command.type);
    await this.sessions.update(session.id, { lastCommandId: command.commandId });
    return state;
  }
}
```

Reject commands more than 60 seconds old or more than 5 seconds in the future. Compare `sessionId` exactly. Serialization remains one promise tail so rapid start/stop cannot create two offscreen streams.

- [ ] **Step 5: Implement exact start order and user-play wait**

Start validates the fixed tab with `chrome.tabs.get(session.tabId)` and checks `discarded`/`frozen`. It then ensures offscreen, obtains a stream ID for that tab, sends `audio:start`, and only after the offscreen acknowledgement calls `playbackDriver.play(session)`. For `user-play-required`, save both session and capture phase as `awaiting-user-play`, start a 60-second timer keyed by session ID, and wait for `playback:user-started` from the validated document. Expiry sends `audio:discard`, disposes playback, and saves the stable failure.

- [ ] **Step 6: Implement pause/resume/stop and replace old runtime messages**

```ts
const runtimeTypeToCommand = {
  'capture:start': 'capture-start',
  'capture:pause': 'capture-pause',
  'capture:resume': 'capture-resume',
  'capture:stop': 'capture-stop'
} as const;
```

Pause calls driver pause then `audio:pause`; resume calls driver play then `audio:resume`; stop calls `audio:stop`, waits only for the stop acknowledgement (not the full ASR completion), disposes the driver, and preserves the target until the separate `target-disconnect`. Remove `capture:toggle` from popup and service-worker routing after its tests are migrated.

- [ ] **Step 7: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/capture-controller.test.ts apps/chrome-extension/tests/service-worker-reliability.test.ts apps/chrome-extension/tests/store-playback-driver.test.ts apps/chrome-extension/tests/cdp-playback-driver.test.ts
npm run build:all --workspace=@voivox/chrome-extension
npm run typecheck --workspace=@voivox/chrome-extension
git add apps/chrome-extension/src/capture-controller.ts apps/chrome-extension/src/service-worker-core.ts apps/chrome-extension/src/popup.ts apps/chrome-extension/tests
git commit -m "feat: capture only the armed Voice VAC tab"
```

Expected: fixed-tab tests PASS even after active-tab switching; both channels build.

### Task 12: Add an authenticated desktop-to-extension command broker

**Files:**
- Create: `packages/core/src/extension-command-broker.ts`
- Create: `packages/core/tests/extension-command-broker.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/loopback-server.ts`
- Modify: `packages/core/tests/loopback-server.test.ts`

**Interfaces:**
- Produces: `ExtensionCommandBroker.publish`, `.readAfter`, `.waitAfter`, `.close`.
- Produces loopback routes: primary-token `POST /v1/extension-commands` and extension-token `GET /v1/native/extension-commands?after=<cursor>&wait=<ms>`.

- [ ] **Step 1: Write failing queue and long-poll tests**

```ts
it('returns commands once after a monotonic cursor', async () => {
  const broker = new ExtensionCommandBroker();
  const published = broker.publish(commandInput('capture-start'));
  expect(broker.readAfter(0)).toEqual({ cursor: 1, commands: [published] });
  expect(broker.readAfter(1)).toEqual({ cursor: 1, commands: [] });
});

it('wakes a bounded waiter when a command is published', async () => {
  const broker = new ExtensionCommandBroker();
  const waiting = broker.waitAfter(0, 20_000);
  const command = broker.publish(commandInput('capture-pause'));
  await expect(waiting).resolves.toEqual({ cursor: 1, commands: [command] });
});
```

Also test 256-command retention, stale cursor recovery, `close()` resolving waiters, and command immutability.

- [ ] **Step 2: Write failing route/authentication tests**

```ts
const rejected = await fetch(`${server.baseUrl}/v1/native/extension-commands?after=0&wait=0`);
expect(rejected.status).toBe(401);

const accepted = await fetch(`${server.baseUrl}/v1/native/extension-commands?after=0&wait=0`, {
  headers: { authorization: 'Bearer restricted-extension-token' }
});
expect(accepted.status).toBe(200);
expect(await accepted.json()).toEqual({ cursor: 0, commands: [] });
```

Assert the extension token cannot POST commands, the primary token cannot use extension import routes without the extension origin, malformed commands return 400, and `wait` is clamped to `0...20000`.

- [ ] **Step 3: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run packages/core/tests/extension-command-broker.test.ts packages/core/tests/loopback-server.test.ts
```

Expected: FAIL because broker and command routes do not exist.

- [ ] **Step 4: Implement the command queue**

```ts
export type ExtensionCommandType = 'drag-begin' | 'drag-cancel' | 'capture-start' |
  'capture-pause' | 'capture-resume' | 'capture-stop' | 'target-disconnect';

export type ExtensionCommandEnvelope = {
  protocolVersion: 2;
  commandId: string;
  sessionId: string;
  type: ExtensionCommandType;
  issuedAt: number;
};

export class ExtensionCommandBroker {
  publish(input: ExtensionCommandEnvelope): ExtensionCommandEnvelope;
  readAfter(cursor: number): ExtensionCommandBatch;
  waitAfter(cursor: number, waitMs: number): Promise<ExtensionCommandBatch>;
  close(): void;
}
```

Copy every command on ingress/egress. Increment the cursor once per accepted command. Keep the latest 256 commands. `waitAfter` resolves immediately when data exists, otherwise installs one bounded timer and removes its waiter on resolve/close.

- [ ] **Step 5: Add the two loopback routes with separate authority**

`POST /v1/extension-commands` is outside the `/v1/extension/*` branch and requires the primary desktop/MCP bearer token. It validates protocol 2, UUID command/session IDs, closed type union, and finite `issuedAt`.

`GET /v1/native/extension-commands` requires `options.extensionToken`; it accepts exactly `after` and `wait`, calls `broker.waitAfter`, sets `cache-control:no-store`, and never includes either token in the response. Pass an optional `extensionCommands` broker into `createVoivoxLoopbackServer`; create one by default and close it when the server closes.

- [ ] **Step 6: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run packages/core/tests/extension-command-broker.test.ts packages/core/tests/loopback-server.test.ts
npm run typecheck --workspace=@voivox/core
git add packages/core/src/extension-command-broker.ts packages/core/src/index.ts packages/core/src/loopback-server.ts packages/core/tests
git commit -m "feat: broker desktop commands to the Chrome extension"
```

### Task 13: Relay commands over a long-lived Native Messaging port

**Files:**
- Create: `native/macos/Sources/VOIVOXNativeHost/NativeCommandRelay.swift`
- Create: `native/macos/Tests/VOIVOXNativeHostTests/NativeCommandRelayTests.swift`
- Modify: `native/macos/Sources/VOIVOXNativeHost/NativeHostProtocol.swift`
- Modify: `native/macos/Tests/VOIVOXNativeHostTests/NativeHostProtocolTests.swift`
- Create: `apps/chrome-extension/src/native-command-channel.ts`
- Create: `apps/chrome-extension/tests/native-command-channel.test.ts`
- Modify: `apps/chrome-extension/src/service-worker-core.ts`

**Interfaces:**
- Consumes: protocol-two `connect`, broker batches, `CaptureController.execute`, content `drag:begin|cancel` messages.
- Produces: one `chrome.runtime.connectNative('com.voivox.bridge')` port per service-worker lifetime and framed command messages.

- [ ] **Step 1: Write failing Swift protocol and relay tests**

```swift
@Test("accepts only the exact protocol-two connect request")
func acceptsConnect() throws {
    let request = try NativeHostRequest.parse(
        Data(#"{"protocolVersion":2,"type":"connect"}"#.utf8)
    )
    #expect(request == .connect)
}

@Test("relays an authenticated command batch without tokens")
func relaysBatch() throws {
    let relay = NativeCommandRelay(fetch: { _, _ in
        Data(#"{"cursor":1,"commands":[{"protocolVersion":2,"commandId":"11111111-1111-4111-8111-111111111111","sessionId":"22222222-2222-4222-8222-222222222222","type":"capture-start","issuedAt":1000}]}"#.utf8)
    })
    let messages = try relay.pollOnce(connection: fixtureConnection, after: 0)
    #expect(messages.cursor == 1)
    #expect(String(decoding: messages.commands[0], as: UTF8.self).contains("restricted-token") == false)
}
```

Also reject unknown command fields/types, non-loopback URLs, invalid cursors, and responses containing token-like extra fields.

- [ ] **Step 2: Write failing extension-channel tests**

```ts
it('connects with protocol two and dispatches a command once', async () => {
  const port = nativePortHarness();
  const dispatch = vi.fn().mockResolvedValue(undefined);
  connectNativeCommandChannel({ connectNative: () => port, dispatch });
  expect(port.postMessage).toHaveBeenCalledWith({ protocolVersion: 2, type: 'connect' });

  port.emit(command('capture-start', { commandId: '11111111-1111-4111-8111-111111111111' }));
  port.emit(command('capture-start', { commandId: '11111111-1111-4111-8111-111111111111' }));
  await flushPromises();
  expect(dispatch).toHaveBeenCalledOnce();
});
```

Add tests for exponential reconnect capped at 30 seconds, disconnect timer cleanup, wrong protocol rejection, wrong session rejection by the controller, and `drag-begin` forwarding to the exact stored document.

- [ ] **Step 3: Run and verify RED**

```bash
cd voivox-workspace
swift test --package-path native/macos --filter NativeCommandRelayTests
npm exec vitest -- run apps/chrome-extension/tests/native-command-channel.test.ts
```

Expected: both suites fail because version-two connect and relay/channel code do not exist.

- [ ] **Step 4: Extend the Native Host without weakening discovery**

```swift
enum NativeHostRequest: Equatable {
    case discover
    case connect

    static func parse(_ data: Data) throws -> NativeHostRequest {
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let object, Set(object.keys) == ["protocolVersion", "type"] else {
            throw NativeHostError.unsupportedRequest
        }
        if object["protocolVersion"] as? Int == 1, object["type"] as? String == "discover" { return .discover }
        if object["protocolVersion"] as? Int == 2, object["type"] as? String == "connect" { return .connect }
        throw NativeHostError.unsupportedRequest
    }
}
```

Version-one discovery remains one response with the current proof. Version-two connect verifies the same connection file/proof, writes `{protocolVersion:2,service:'voivox',status:'connected'}`, then enters the relay loop. It polls at most 20 seconds, frames each validated command separately, advances its cursor only after successful write, and backs off 250 ms to 5 seconds on network errors. EOF/process termination ends the loop.

- [ ] **Step 5: Implement the extension port and unified dispatch**

```ts
export function connectNativeCommandChannel(deps: NativeChannelDependencies): NativeCommandChannel {
  const port = deps.connectNative('com.voivox.bridge');
  port.postMessage({ protocolVersion: 2, type: 'connect' });
  port.onMessage.addListener((value) => void acceptCommand(value, deps));
  port.onDisconnect.addListener(() => scheduleReconnect(deps));
  return { disconnect: () => port.disconnect() };
}
```

Use a bounded 512-ID de-duplication cache in the channel; the `CaptureController` remains the second idempotency layer. `drag-begin`/`drag-cancel` send to `session.tabId` with `{documentId,frameId}`; capture and disconnect commands call the controller. Start the channel from shared service-worker core for both Store and Automation.

- [ ] **Step 6: Verify and commit**

```bash
cd voivox-workspace
swift test --package-path native/macos --filter VOIVOXNativeHostTests
npm exec vitest -- run apps/chrome-extension/tests/native-command-channel.test.ts apps/chrome-extension/tests/capture-controller.test.ts
npm run typecheck --workspace=@voivox/chrome-extension
git add native/macos/Sources/VOIVOXNativeHost native/macos/Tests/VOIVOXNativeHostTests apps/chrome-extension/src/native-command-channel.ts apps/chrome-extension/src/service-worker-core.ts apps/chrome-extension/tests/native-command-channel.test.ts
git commit -m "feat: relay native Voice VAC controls into Chrome"
```

### Task 14: Allow exactly the two stable extension origins

**Files:**
- Modify: `packages/core/src/loopback-server.ts`
- Modify: `packages/core/tests/loopback-server.test.ts`
- Modify: `apps/desktop/src/main/native-messaging.ts`
- Modify: `apps/desktop/tests/native-messaging.test.ts`

**Interfaces:**
- Produces exact origin constants for Store and Automation, with and without Native Messaging trailing slash.
- Preserves all existing token boundaries and disallows wildcard CORS.

- [ ] **Step 1: Write failing dual-origin CORS tests**

```ts
it.each([
  'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno',
  'chrome-extension://ciijinidnlbokpbeiabifcnoighmbnmh'
])('echoes the exact allowed extension origin %s', async (origin) => {
  const response = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions`, {
    headers: { authorization: `Bearer ${extensionToken}`, origin }
  });
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('vary')).toContain('Origin');
});

it('rejects all other extension origins without a CORS echo', async () => {
  const response = await fetch(`${server.baseUrl}/v1/extension/tunnel-sessions`, {
    headers: { authorization: `Bearer ${extensionToken}`, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
  });
  expect(response.status).toBe(403);
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
});
```

- [ ] **Step 2: Write the failing Native Messaging manifest test**

```ts
expect(manifest.allowed_origins).toEqual([
  'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno/',
  'chrome-extension://ciijinidnlbokpbeiabifcnoighmbnmh/'
]);
```

- [ ] **Step 3: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run packages/core/tests/loopback-server.test.ts apps/desktop/tests/native-messaging.test.ts
```

Expected: FAIL because only the Store origin is accepted and installed.

- [ ] **Step 4: Replace the singular origin with an exact set**

```ts
export const VOIVOX_STORE_EXTENSION_ORIGIN = 'chrome-extension://pepfpbobjbjehhhcjiokmneclohlffno';
export const VOIVOX_AUTOMATION_EXTENSION_ORIGIN = 'chrome-extension://ciijinidnlbokpbeiabifcnoighmbnmh';
export const VOIVOX_EXTENSION_ORIGINS = new Set([
  VOIVOX_STORE_EXTENSION_ORIGIN,
  VOIVOX_AUTOMATION_EXTENSION_ORIGIN
]);
```

Change `applyExtensionCors(response, origin)` to echo only a set member. Pass the request origin explicitly at health and extension routes. Never set `*`, never infer an origin from an extension-supplied body, and never allow an omitted origin on `/v1/extension/*`.

- [ ] **Step 5: Install both trailing-slash Native Messaging origins**

```ts
export const VOIVOX_NATIVE_EXTENSION_ORIGINS = [
  `${VOIVOX_STORE_EXTENSION_ORIGIN}/`,
  `${VOIVOX_AUTOMATION_EXTENSION_ORIGIN}/`
] as const;
```

Write exactly that array to every generated host manifest.

- [ ] **Step 6: Verify and commit**

```bash
cd voivox-workspace
npm exec vitest -- run packages/core/tests/loopback-server.test.ts apps/desktop/tests/native-messaging.test.ts apps/chrome-extension/tests/manifest-identity.test.ts
npm run typecheck
git add packages/core/src/loopback-server.ts packages/core/tests/loopback-server.test.ts apps/desktop/src/main/native-messaging.ts apps/desktop/tests/native-messaging.test.ts
git commit -m "security: allow only the two Voice VAC extension origins"
```

### Task 15: Package, document, and validate both installable channels

**Files:**
- Modify: `.github/workflows/package-macos.yml`
- Modify: `README.md`
- Modify: `docs/release/RELEASE.md`
- Create: `docs/evidence/voice-vac-chrome-dual-build.md`
- Create: `apps/chrome-extension/tests/package-artifacts.test.ts`

**Interfaces:**
- Consumes: `package:store`, `package:automation`, both stable identities, real Chrome acceptance checklist.
- Produces: two labeled ZIPs and a release rule that submits only Store to Chrome Web Store.

- [ ] **Step 1: Write the failing package-artifact test**

```ts
it.each([
  ['store', 'Voice-VAC-Store-0.1.1.zip', false],
  ['automation', 'Voice-VAC-Automation-0.1.1.zip', true]
] as const)('packages an installable %s artifact', async (channel, filename, hasDebugger) => {
  await execFileAsync('npm', ['run', `package:${channel}`], { cwd: extensionDirectory });
  const entries = await listZipEntries(new URL(`../release/${filename}`, import.meta.url));
  expect(entries).toContain('manifest.json');
  const manifest = await readManifestFromZip(filename);
  expect(manifest.permissions.includes('debugger')).toBe(hasDebugger);
});
```

Also assert ZIP roots contain no extra `store/` or `automation/` directory, both include notices/licenses/WASM, Store ZIP byte scan is clean, and Automation ZIP ID matches its fixed key.

- [ ] **Step 2: Run and verify RED**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests/package-artifacts.test.ts
```

Expected: FAIL until both package commands and channel filenames are complete.

- [ ] **Step 3: Update CI to build and upload both labeled artifacts**

```yaml
- run: npm run package:store --workspace=@voivox/chrome-extension
- run: npm run package:automation --workspace=@voivox/chrome-extension
- uses: actions/upload-artifact@v4
  with:
    name: Voice-VAC-judge-builds
    path: |
      apps/chrome-extension/release/Voice-VAC-Store-*.zip
      apps/chrome-extension/release/Voice-VAC-Automation-*.zip
      SHA256SUMS.txt
```

Add both ZIP patterns to checksums and tagged GitHub releases. Add a workflow assertion that only `Voice-VAC-Store-*` is copied into any Web Store submission directory; Automation remains developer/enterprise side-load only.

- [ ] **Step 4: Update install/security documentation**

README and release guide must state:

```text
Voice VAC Store: Chrome Web Store candidate; no debugger permission or CDP code.
Voice VAC Automation: developer/enterprise side-load; debugger permission is required and visibly disclosed.
Click the chosen extension once on each target tab to arm it. A successful nozzle drop enters Ready; the red button starts capture.
```

Replace old `apps/chrome-extension/dist` instructions with `dist/store` and `dist/automation`. List both IDs and both Native Messaging origins. Do not claim Automation bypasses DRM, login, frozen tabs, or site access controls.

- [ ] **Step 5: Run the complete automated gate**

```bash
cd voivox-workspace
npm exec vitest -- run apps/chrome-extension/tests packages/core/tests/extension-command-broker.test.ts packages/core/tests/loopback-server.test.ts apps/desktop/tests/native-messaging.test.ts
npm run typecheck
npm run build:all --workspace=@voivox/chrome-extension
npm run package:store --workspace=@voivox/chrome-extension
npm run package:automation --workspace=@voivox/chrome-extension
swift test --package-path native/macos
unzip -t apps/chrome-extension/release/Voice-VAC-Store-0.1.1.zip
unzip -t apps/chrome-extension/release/Voice-VAC-Automation-0.1.1.zip
```

Expected: every command exits 0; no unhandled warnings; both ZIP integrity checks report `No errors detected`.

- [ ] **Step 6: Execute and record the real Chrome matrix**

Record observed result, Chrome version, macOS version, tab ID, build channel, and error code for each row:

```text
Store: armed direct <video> / start / trusted-click fallback / pause / resume / stop
Store: switch active tab before start; capture remains on armed tab
Store: cross-origin iframe degrades to tab-audio or one-click prompt
Store: navigate and close target; session invalidates with stable code
Automation: direct media Runtime.evaluate without focus change
Automation: embedded player internal click without macOS cursor movement
Automation: debugger detach and sleeping/discarded tab failures
Both: other Chrome tab, Spotify, Logic Pro, microphone, and system devices remain outside D Channel
```

Save screenshots/log hashes and factual outcomes in `docs/evidence/voice-vac-chrome-dual-build.md`; failed rows remain explicitly failed rather than being described as complete.

- [ ] **Step 7: Commit packaging documentation and recorded evidence**

```bash
cd voivox-workspace
git add .github/workflows/package-macos.yml README.md docs/release/RELEASE.md docs/evidence/voice-vac-chrome-dual-build.md apps/chrome-extension/tests/package-artifacts.test.ts
git commit -m "release: package Store and Automation Chrome builds"
```

---

## Final Completion Gate

- [ ] `dist/store` and `dist/automation` are created from different service-worker entry files.
- [ ] Store manifest has exactly six permissions and every Store JavaScript byte passes the forbidden-token scan.
- [ ] Automation manifest requires `debugger`; its worker contains the tested `Runtime.evaluate` and `Input.dispatchMouseEvent` paths.
- [ ] Capture remains bound to the armed `tabId + frameId + documentId` after active-tab and active-window changes.
- [ ] Wrong, stale, malformed, or untrusted drops never call `preventDefault` and never mutate the target session.
- [ ] Successful drop enters `ready`; no stream or playback starts before `capture-start`.
- [ ] Store trusted-click fallback, Automation no-focus CDP playback, pause, resume, stop/flush, navigation invalidation, and debugger detach all have passing tests.
- [ ] Native commands are authenticated, framed, de-duplicated, and routed through one controller.
- [ ] Loopback and Native Messaging accept only the two fixed extension origins.
- [ ] Both ZIPs pass integrity and identity checks; only Store is eligible for Web Store submission.
- [ ] Real Chrome evidence distinguishes automated proof from manual audio-isolation observations.

## Execution Handoff

Use `superpowers:subagent-driven-development` to execute one task at a time with a fresh implementation subagent and review gate after every commit. If executing in one session instead, use `superpowers:executing-plans` and stop at each task boundary for test and diff review.
