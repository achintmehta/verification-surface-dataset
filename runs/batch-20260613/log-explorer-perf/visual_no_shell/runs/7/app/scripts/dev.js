import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function run(name, args) {
  const child = spawn(npm, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = `[${name}]`;
  child.stdout.on('data', d => process.stdout.write(`${prefix} ${d}`));
  child.stderr.on('data', d => process.stderr.write(`${prefix} ${d}`));
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) {
      console.error(`${prefix} exited with ${code}`);
      shutdown();
    }
  });
  return child;
}

let shuttingDown = false;
const children = [run('api', ['run', 'server']), run('web', ['run', 'client'])];

function shutdown() {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 250).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
