const { exec } = require('child_process');

const vite = exec('npx vite build client');

vite.stdout.on('data', data => console.log(data));
vite.stderr.on('data', data => console.error(data));
vite.on('close', code => console.log(`Vite exited with code ${code}`));
