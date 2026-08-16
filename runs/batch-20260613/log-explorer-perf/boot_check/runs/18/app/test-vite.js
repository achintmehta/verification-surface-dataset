const http = require('http');
const { exec } = require('child_process');

const child = exec('npm run start');

child.stdout.on('data', (data) => {
  console.log(data);
  if (data.includes('ready in') || data.includes('Local:')) {
    http.get('http://localhost:3000', (res) => {
      console.log('Vite status:', res.statusCode);
      process.exit(0);
    }).on('error', (e) => {
      console.error('Vite error:', e);
      process.exit(1);
    });
  }
});

child.stderr.on('data', (data) => {
  console.error(data);
});

setTimeout(() => {
  console.log('Timeout');
  process.exit(1);
}, 10000);
