import { spawn } from 'node:child_process';

const procs = [
  spawn('npm', ['run', 'server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'client'], { stdio: 'inherit', shell: true })
];

function shutdown(signal) {
  for (const child of procs) child.kill(signal);
  process.exit(signal === 'SIGINT' ? 0 : 1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const child of procs) {
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown('SIGTERM');
  });
}
