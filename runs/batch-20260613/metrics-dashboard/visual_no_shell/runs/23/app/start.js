import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Start backend
const backend = spawn('node', [join(__dirname, 'server', 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT || '3001' }
});

// Wait a moment for backend to start, then start Vite
setTimeout(() => {
  const frontend = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', '5173'], {
    stdio: 'inherit',
    cwd: __dirname,
    env: { ...process.env }
  });

  frontend.on('error', (err) => {
    console.error('Frontend failed to start:', err);
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
}, 2000);

backend.on('error', (err) => {
  console.error('Backend failed to start:', err);
});
