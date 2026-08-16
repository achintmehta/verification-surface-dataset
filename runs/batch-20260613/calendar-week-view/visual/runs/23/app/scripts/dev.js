import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const backend = spawn('node', ['server/index.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
});

const frontend = spawn('npx', ['vite', '--port', '5173'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
});

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
