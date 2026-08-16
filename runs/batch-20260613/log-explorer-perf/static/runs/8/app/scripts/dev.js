import { spawn } from 'node:child_process';

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const children = [
  spawn(npmCmd, ['run', 'server'], { stdio: 'inherit', env: process.env }),
  spawn(npmCmd, ['run', 'client'], { stdio: 'inherit', env: process.env })
];

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (!stopping) {
      stop(signal || 'SIGTERM');
      process.exitCode = code ?? 1;
    }
  });
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
