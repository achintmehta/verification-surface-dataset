import { spawn } from 'node:child_process';

const commands = [
  ['server', 'node', ['server/index.js'], { PORT: process.env.PORT || '3000' }],
  ['client', 'vite', ['--host', '0.0.0.0'], {}],
];

const children = commands.map(([name, cmd, args, env]) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  child.stdout.on('data', (buf) => process.stdout.write(`[${name}] ${buf}`));
  child.stderr.on('data', (buf) => process.stderr.write(`[${name}] ${buf}`));
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') {
      console.error(`[${name}] exited with code ${code ?? signal}`);
      shutdown(code || 1);
    }
  });
  return child;
});

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 100).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
