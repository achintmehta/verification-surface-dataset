import { spawn } from 'child_process';

const server = spawn('node', ['server.js']);

server.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

server.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

setTimeout(async () => {
  const { execSync } = await import('child_process');
  try {
    const output = execSync('node test.js');
    console.log(output.toString());
  } catch (e) {
    console.error(e.stdout.toString());
    console.error(e.stderr.toString());
  }
  server.kill();
}, 2000);
