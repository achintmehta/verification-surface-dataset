import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['server/index.js'], { stdio: 'inherit', shell: true }),
  spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', shell: true })
];

function shutdown(code = 0) {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
for (const p of procs) p.on('exit', code => { if (code) shutdown(code); });
