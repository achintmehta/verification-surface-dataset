import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';
const children = [
  spawn(npm, ['run', 'server'], { stdio: 'inherit', shell: false }),
  spawn(npm, ['run', 'client'], { stdio: 'inherit', shell: false })
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

let exiting = false;
for (const child of children) {
  child.on('exit', (code) => {
    if (!exiting && code && code !== 0) {
      exiting = true;
      shutdown('SIGTERM');
      process.exit(code);
    }
  });
}
