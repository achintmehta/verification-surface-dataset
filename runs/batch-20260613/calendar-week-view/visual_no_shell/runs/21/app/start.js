// Start both backend and frontend dev servers
const { spawn } = require('child_process');
const path = require('path');

// Start backend
const backend = spawn('node', [path.join(__dirname, 'server', 'index.js')], {
  stdio: 'inherit',
  env: { ...process.env, PORT: process.env.PORT || '3001' }
});

// Start Vite dev server
const frontend = spawn(path.join(__dirname, 'node_modules', '.bin', 'vite'), ['--port', '5173', '--host'], {
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
