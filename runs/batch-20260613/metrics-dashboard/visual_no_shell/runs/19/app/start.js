const { spawn } = require('child_process');

const backend = spawn('node', ['backend/server.js'], { stdio: 'inherit' });
const frontend = spawn('npx', ['vite', 'frontend', '--port', '3000'], { stdio: 'inherit' });

process.on('SIGINT', () => {
  backend.kill();
  frontend.kill();
  process.exit();
});
