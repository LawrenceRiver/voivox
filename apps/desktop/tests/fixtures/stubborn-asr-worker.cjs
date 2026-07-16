process.on('SIGTERM', () => undefined);
process.stdin.resume();
process.stdout.write('READY\n');
