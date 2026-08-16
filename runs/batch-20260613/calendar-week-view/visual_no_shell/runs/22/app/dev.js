import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Start backend
const backend = spawn('node', [resolve(__dirname, 'server/index.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: '3001' }
});

// Start frontend (vite)
const frontend = spawn('npx', ['vite', '--port', '5173', '--host'], {
  stdio: 'inherit',
  cwd: __dirname,
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

backend.on('exit', (code) => {
  console.log(`Backend exited with code ${code}`);
  frontend.kill();
  process.exit(code);
});

frontend.on('exit', (code) => {
  console.log(`Frontend exited with code ${code}`);
  backend.kill();
  process.exit(code);
});
