const { spawn } = require('child_process');
const path = require('path');

// Start backend
const backend = spawn('node', ['server/index.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env }
});

// Start frontend via vite
const frontend = spawn('npx', ['vite', 'client', '--port', '5173', '--host'], {
  cwd: __dirname,
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
