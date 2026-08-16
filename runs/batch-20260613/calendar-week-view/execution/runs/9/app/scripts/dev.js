import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['server/index.js'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npx', ['vite', '--host', '0.0.0.0'], { stdio: 'inherit', shell: process.platform === 'win32' })
];

function shutdown(signal) {
  for (const p of procs) p.kill(signal);
  process.exit();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

let exiting = false;
for (const p of procs) {
  p.on('exit', (code) => {
    if (!exiting && code && code !== 0) {
      exiting = true;
      for (const other of procs) if (other !== p) other.kill('SIGTERM');
      process.exit(code);
    }
  });
}
