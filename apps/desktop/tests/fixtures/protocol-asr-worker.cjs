const fs = require('node:fs');
const readline = require('node:readline');

const scenario = process.env.PROTOCOL_WORKER_SCENARIO || 'ready';
const delay = Number(process.env.PROTOCOL_WORKER_DELAY_MS || 30);
const receiveLog = process.env.PROTOCOL_WORKER_RECEIVE_LOG;
let busy = false;

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function ready() {
  emit({ type: 'ready', model_id: 'fixture/Qwen3-ASR-0.6B', device: 'cpu' });
}

emit({ type: 'status', status: 'booting' });

if (scenario === 'malformed-startup') {
  process.stdout.write('{not-json}\n');
} else if (scenario === 'fatal-startup') {
  emit({
    type: 'fatal',
    code: process.env.PROTOCOL_WORKER_FATAL_CODE || 'ASR_MODEL_MISSING',
    error: 'fixture detail must not replace the stable error',
    retryable: false
  });
  process.exitCode = 1;
} else if (scenario === 'startup-hard-timeout') {
  const timer = setInterval(() => emit({ type: 'status', status: 'model_loading' }), delay);
  timer.unref();
} else if (scenario === 'startup-inactivity-timeout') {
  // Remain alive without reporting more startup activity.
  setInterval(() => {}, 1_000);
} else if (scenario === 'delayed-ready') {
  setTimeout(() => emit({ type: 'status', status: 'model_loading' }), delay);
  setTimeout(ready, delay * 2);
} else {
  emit({ type: 'status', status: 'model_loading' });
  ready();
}

if (scenario === 'stubborn') {
  process.on('SIGTERM', () => {});
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (receiveLog) {
    fs.appendFileSync(receiveLog, `${line}\n`);
  }
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (scenario === 'malformed-response') {
    process.stdout.write('{not-json}\n');
    return;
  }
  if (scenario === 'fatal-request') {
    emit({
      type: 'fatal',
      code: process.env.PROTOCOL_WORKER_FATAL_CODE || 'ASR_RUNTIME_MISSING',
      error: 'fixture fatal',
      retryable: false
    });
    return;
  }
  if (scenario === 'serial' && busy) {
    emit({ type: 'error', id: request.id, code: 'ASR_INFERENCE_FAILED', error: 'parallel request', retryable: true });
    return;
  }

  busy = true;
  const accept = () => {
    emit({ type: 'accepted', id: request.id });
    if (scenario === 'no-result') {
      return;
    }
    const finish = () => {
      emit({ type: 'result', id: request.id, text: `transcript:${request.audioPath || 'pcm'}`, language: 'English' });
      busy = false;
    };
    if (scenario === 'slow-result' || scenario === 'serial') {
      setTimeout(finish, delay);
    } else {
      finish();
    }
  };

  if (scenario === 'no-accept') {
    return;
  }
  if (scenario === 'slow-accept') {
    setTimeout(accept, delay);
  } else {
    accept();
  }
});
