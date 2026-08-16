import { spawn } from 'child_process';

const procs = [
  spawn(process.execPath, ['server/index.js'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3000' } }),
  spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', env: { ...process.env, VITE_API_BASE: process.env.VITE_API_BASE || 'http://localhost:3000' } })
];

function shutdown(code = 0) {
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  process.exit(code);
}
for (const p of procs) p.on('exit', code => { if (code) shutdown(code); });
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
