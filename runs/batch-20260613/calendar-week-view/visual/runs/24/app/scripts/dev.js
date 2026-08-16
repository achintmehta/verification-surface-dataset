import { spawn } from 'child_process';

const backend = spawn('node', ['server/index.js'], { stdio: 'inherit' });
const frontend = spawn('npx', ['vite', '--port', '5173'], { stdio: 'inherit' });

process.on('SIGINT', () => {
  backend.kill();
  frontend.kill();
  process.exit();
});

process.on('SIGTERM', () => {
  backend.kill();
  frontend.kill();
  process.exit();
});
