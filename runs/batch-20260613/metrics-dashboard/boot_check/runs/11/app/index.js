// Root entry shim (CommonJS): boot the backend server.
// Spawn the server's own ESM entry as a child process so module systems don't clash.
const { spawn } = require('node:child_process');
const path = require('node:path');

const entry = path.join(__dirname, 'server', 'src', 'index.js');
const child = spawn(process.execPath, [entry], { stdio: 'inherit' });

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
