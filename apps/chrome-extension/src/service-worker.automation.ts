import { createServiceWorkerRuntime } from './service-worker-core.js';

// Task 9 replaces this placeholder with the injected Automation playback driver.
createServiceWorkerRuntime({ channel: 'automation' });
