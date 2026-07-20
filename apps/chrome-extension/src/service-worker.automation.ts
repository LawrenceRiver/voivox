import { createServiceWorkerRuntime } from './service-worker-core.js';
import { CdpPlaybackDriver } from './automation/cdp-playback-driver.js';

createServiceWorkerRuntime({
  channel: 'automation',
  createPlaybackDriver: () => new CdpPlaybackDriver()
});
