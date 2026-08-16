import { spawn } from 'node:child_process';
import process from 'node:process';

const isWin = process.platform === 'win32';
const children = [];

function run(name, command, args) {
  const child = spawn(command, args, { stdio: 'inherit', shell: isWin });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal) return;
    if (code && code !== 0) {
      console.error(`${name} exited with code ${code}`);
      shutdown(code);
    }
  });
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', 'node', ['server/index.js']);
run('client', 'npx', ['vite', '--host', '0.0.0.0']);
