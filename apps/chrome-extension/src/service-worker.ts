import { createServiceWorkerRuntime } from './service-worker-core.js';

export * from './service-worker-core.js';

createServiceWorkerRuntime({ channel: 'store' });
