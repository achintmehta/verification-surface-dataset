import { spawn } from 'node:child_process';

const children = [];

function run(name, cmd, args, env = {}) {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
    shell: process.platform === 'win32'
  });
  children.push(child);
  const prefix = `[${name}]`;
  child.stdout.on('data', d => process.stdout.write(`${prefix} ${d}`));
  child.stderr.on('data', d => process.stderr.write(`${prefix} ${d}`));
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) {
      console.error(`${prefix} exited with ${code}`);
      shutdown(code ?? 1);
    }
  });
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 250).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// The Express app serves both the API and the Vite-style static frontend in this
// execution environment. A separate `npm run client` script is still provided for
// normal Vite development.
run('app', 'node', ['server/index.js']);
