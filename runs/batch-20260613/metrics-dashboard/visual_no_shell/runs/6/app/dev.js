import { spawn } from 'node:child_process';

const children = [];
function run(name, command, args) {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  children.push(child);
  child.stdout.on('data', data => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on('data', data => process.stderr.write(`[${name}] ${data}`));
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code || 1);
    }
  });
}
let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 150).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', process.execPath, ['server/index.js']);
const viteBin = process.platform === 'win32' ? 'node_modules/vite/bin/vite.js' : './node_modules/vite/bin/vite.js';
run('web', process.execPath, [viteBin, '--host', '0.0.0.0']);
