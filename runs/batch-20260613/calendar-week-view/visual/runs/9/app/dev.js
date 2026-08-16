import { spawn } from 'node:child_process';

const children = [
  spawn('npm', ['run', 'server'], { stdio: 'inherit', shell: true }),
  spawn('npm', ['run', 'client'], { stdio: 'inherit', shell: true })
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
  process.exit(signal === 'SIGINT' ? 0 : 1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown('SIGTERM');
  });
}
