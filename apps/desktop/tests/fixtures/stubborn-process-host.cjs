#!/usr/bin/env node

const action = process.argv[2];
const pid = process.argv[3];

process.on('SIGINT', () => undefined);
process.on('SIGTERM', () => undefined);

if (action === 'record' && pid === '42') {
  process.stdout.write('{"event":"started"}\n');
}

setTimeout(() => process.exit(0), 600);
