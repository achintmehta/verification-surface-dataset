import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npmCmd, ['run', 'server'], { stdio: 'inherit' }),
  spawn(npmCmd, ['run', 'client'], { stdio: 'inherit' })
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
