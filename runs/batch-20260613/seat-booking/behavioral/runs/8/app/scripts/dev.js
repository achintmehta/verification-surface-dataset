import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3000' } }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit' }),
];

function shutdown(code = 0) {
  for (const proc of procs) proc.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
for (const proc of procs) {
  proc.on('exit', (code) => {
    if (code && code !== 0) shutdown(code);
  });
}
