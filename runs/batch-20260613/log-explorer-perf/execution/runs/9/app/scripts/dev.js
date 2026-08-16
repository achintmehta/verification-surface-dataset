import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const children = [];

function run(name, command, args, opts = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: isWin,
    ...opts,
  });
  children.push(child);
  const prefix = `[${name}]`;
  child.stdout.on('data', d => process.stdout.write(`${prefix} ${d}`));
  child.stderr.on('data', d => process.stderr.write(`${prefix} ${d}`));
  child.on('exit', code => {
    if (!shuttingDown && code !== 0) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown(code ?? 1);
    }
  });
  return child;
}

let shuttingDown = false;
function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 200).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('api', 'npm', ['--prefix', 'server', 'run', 'dev']);
run('web', 'npm', ['--prefix', 'client', 'run', 'dev']);
