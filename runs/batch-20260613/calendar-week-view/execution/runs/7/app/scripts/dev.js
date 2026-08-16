import { spawn } from 'node:child_process';

const commands = [
  ['server', 'npm', ['run', 'dev:server']],
  ['client', 'npm', ['run', 'dev:client']]
];

const children = commands.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code, signal) => {
    if (code && code !== 0) console.error(`[${name}] exited with code ${code}`);
    if (signal) console.error(`[${name}] exited with signal ${signal}`);
  });
  return child;
});

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
