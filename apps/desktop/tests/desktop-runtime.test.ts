import { describe, expect, it } from 'vitest';

import { DesktopRuntime } from '../src/main/desktop-runtime.js';

describe('DesktopRuntime', () => {
  it('presents one active session and keeps its completed session in the local library', () => {
    const runtime = new DesktopRuntime();

    const started = runtime.startCapture({ kind: 'chrome-tab', label: '当前 Chrome 标签页' });
    expect(runtime.getDashboard().activeSession).toMatchObject({ id: started.id, status: 'capturing' });

    runtime.appendDemoSegment(started.id);
    runtime.stopCapture(started.id);

    expect(runtime.getDashboard()).toMatchObject({
      activeSession: undefined,
      sessions: [
        {
          id: started.id,
          status: 'complete',
          rawSegments: [{ text: 'VOIVOX 已收到一段本机测试转写。' }]
        }
      ]
    });
  });
});
