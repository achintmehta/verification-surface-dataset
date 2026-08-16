import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const children = [];

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, ...env }
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill(isWin ? undefined : 'SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', 'npm', ['run', 'dev:server']);
run('client', 'npm', ['run', 'dev:client']);
