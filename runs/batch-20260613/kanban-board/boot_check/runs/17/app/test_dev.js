import { exec } from 'child_process';

const child = exec('npm run dev');
child.stdout.on('data', data => console.log(data));
child.stderr.on('data', data => console.error(data));

setTimeout(() => {
  child.kill();
  process.exit(0);
}, 5000);
