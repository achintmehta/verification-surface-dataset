import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3001' } }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', env: { ...process.env, VITE_API_BASE: process.env.VITE_API_BASE || 'http://localhost:3001' } }),
];

function stop(signal = 'SIGTERM') {
  for (const child of children) child.kill(signal);
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (code && code !== 0) console.error(`dev child exited with code ${code}`);
    stop(signal || 'SIGTERM');
  });
}
