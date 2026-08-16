import { spawn } from 'node:child_process';

const children = [
  spawn('node', ['server/index.js'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5173', 'frontend'], { stdio: 'inherit', shell: process.platform === 'win32' })
];

function stop() {
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });

children.forEach(child => child.on('exit', code => {
  if (code && code !== 0) {
    stop();
    process.exit(code);
  }
}));
