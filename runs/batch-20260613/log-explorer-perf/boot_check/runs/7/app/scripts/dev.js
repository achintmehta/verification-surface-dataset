import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit' }),
  spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', shell: process.platform === 'win32' })
];

function shutdown(code = 0) {
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
for (const p of procs) p.on('exit', (code) => {
  if (code && code !== 0) shutdown(code);
});
