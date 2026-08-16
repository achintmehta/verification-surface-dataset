const http = require('http');

async function fetchQuery(path) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(`http://localhost:3000${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve(Date.now() - start);
      });
    }).on('error', reject);
  });
}

async function testP95(name, path, iterations = 20) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    times.push(await fetchQuery(path));
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(iterations * 0.95)];
  console.log(`${name}: p95 = ${p95}ms`);
}

async function run() {
  await testP95('offset 0', '/api/logs?limit=100&offset=0');
  await testP95('offset 50000', '/api/logs?limit=100&offset=50000');
  await testP95('offset 99900', '/api/logs?limit=100&offset=99900');
  await testP95('severity + deep offset', '/api/logs?limit=100&offset=50000&severity=info');
  await testP95('selective substring + deep offset', '/api/logs?limit=100&offset=1000&q=timeout');
  await testP95('non-selective substring + deep offset', '/api/logs?limit=100&offset=50000&q=e');
}

run();