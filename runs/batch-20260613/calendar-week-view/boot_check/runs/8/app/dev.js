import { spawn } from 'child_process';

const children = [
  spawn('node', ['server.js'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3000' } }),
  spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', env: { ...process.env, VITE_API_BASE: process.env.VITE_API_BASE || 'http://localhost:3000' } })
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
  process.exit(signal === 'SIGINT' ? 0 : 1);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (code && code !== 0) shutdown(signal || 'SIGTERM');
  });
}
