import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const backend = spawn('node', ['server/index.js'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
});

const frontend = spawn('npx', ['vite', 'client', '--port', '5173'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env }
});

process.on('SIGINT', () => {
  backend.kill();
  frontend.kill();
  process.exit();
});

backend.on('exit', (code) => {
  frontend.kill();
  process.exit(code);
});

frontend.on('exit', (code) => {
  backend.kill();
  process.exit(code);
});
