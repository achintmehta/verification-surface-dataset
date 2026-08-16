import { spawn } from 'child_process';

const server = spawn('npm', ['run', 'dev:server'], { stdio: 'inherit' });
const client = spawn('npm', ['run', 'dev:client'], { stdio: 'inherit' });

process.on('SIGINT', () => {
  server.kill();
  client.kill();
  process.exit();
});
