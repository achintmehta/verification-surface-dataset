// Root entry shim (CommonJS): boot the backend server.
const { spawn } = require('node:child_process');
const path = require('node:path');

const entry = path.join(__dirname, 'server', 'src', 'index.js');
const child = spawn(process.execPath, [entry], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
