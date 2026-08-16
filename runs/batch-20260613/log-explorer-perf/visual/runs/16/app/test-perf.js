const http = require('http');

function request(path) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(`http://localhost:3001${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve(Date.now() - start);
      });
    }).on('error', reject);
  });
}

async function run() {
  const paths = [
    '/api/logs?limit=100&offset=0',
    '/api/logs?limit=100&offset=50000',
    '/api/logs?limit=100&offset=99900',
    '/api/logs?limit=100&offset=99900&severity=error',
    '/api/logs?limit=100&offset=50000&q=timeout',
    '/api/logs?limit=100&offset=50000&q=e'
  ];

  for (const path of paths) {
    let times = [];
    for (let i = 0; i < 10; i++) {
      times.push(await request(path));
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`${path}: p95 = ${p95}ms`);
  }
}

run();