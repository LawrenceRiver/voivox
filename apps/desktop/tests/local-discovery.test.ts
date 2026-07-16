import { describe, expect, it, vi } from 'vitest';

import {
  startWithExtensionDiscovery,
  VOIVOX_DISCOVERY_PORT
} from '../src/main/local-discovery.js';

describe('desktop extension discovery port', () => {
  it('uses the stable discovery port when it is available', async () => {
    const start = vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:43817' });

    const result = await startWithExtensionDiscovery(start);

    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith({
      extensionDiscovery: true,
      port: VOIVOX_DISCOVERY_PORT
    });
    expect(result).toEqual({
      extensionDiscovery: true,
      server: { baseUrl: 'http://127.0.0.1:43817' }
    });
  });

  it('falls back to an ephemeral MCP port only after EADDRINUSE', async () => {
    const collision = Object.assign(new Error('address in use'), { code: 'EADDRINUSE' });
    const start = vi.fn()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce({ baseUrl: 'http://127.0.0.1:49152' });

    const result = await startWithExtensionDiscovery(start);

    expect(start.mock.calls).toEqual([
      [{ extensionDiscovery: true, port: VOIVOX_DISCOVERY_PORT }],
      [{ extensionDiscovery: false, port: 0 }]
    ]);
    expect(result).toEqual({
      extensionDiscovery: false,
      server: { baseUrl: 'http://127.0.0.1:49152' }
    });
  });

  it('does not hide failures other than a discovery port collision', async () => {
    const failure = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const start = vi.fn().mockRejectedValue(failure);

    await expect(startWithExtensionDiscovery(start)).rejects.toBe(failure);
    expect(start).toHaveBeenCalledOnce();
  });
});
