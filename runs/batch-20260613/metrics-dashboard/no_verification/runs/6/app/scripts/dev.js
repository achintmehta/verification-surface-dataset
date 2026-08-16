import { spawn } from 'node:child_process';
import process from 'node:process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

const children = [
  spawn(npmCmd, ['run', 'server'], { stdio: 'inherit', env: { ...process.env, PORT: process.env.PORT || '3000' } }),
  spawn(npmCmd, ['run', 'client'], { stdio: 'inherit', env: { ...process.env, VITE_API_BASE: process.env.VITE_API_BASE || 'http://localhost:3000' } })
];

const shutdown = (signal) => {
  for (const child of children) child.kill(signal);
  process.exit(signal === 'SIGINT' ? 0 : 1);
};

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));

children.forEach((child) => {
  child.on('exit', (code) => {
    if (code && code !== 0) shutdown('SIGTERM');
  });
});
