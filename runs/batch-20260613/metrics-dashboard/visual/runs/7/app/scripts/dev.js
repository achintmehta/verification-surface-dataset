import { spawn } from 'node:child_process';

const commands = [
  ['server', 'node', ['server/index.js']],
  ['client', 'npx', ['vite', '--host', '0.0.0.0']],
];

const children = commands.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', (data) => process.stdout.write(`[${name}] ${data}`));
  child.stderr.on('data', (data) => process.stderr.write(`[${name}] ${data}`));
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown();
    }
  });
  return child;
});

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 250);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
