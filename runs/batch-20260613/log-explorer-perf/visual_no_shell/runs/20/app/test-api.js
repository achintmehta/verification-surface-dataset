const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const time = Date.now() - start;
        resolve({ time, data: JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

async function test() {
  // Warmup
  await fetch('http://localhost:3001/api/logs?limit=100&offset=0');
  
  const tests = [
    { name: 'offset 0', url: 'http://localhost:3001/api/logs?limit=100&offset=0' },
    { name: 'offset 50000', url: 'http://localhost:3001/api/logs?limit=100&offset=50000' },
    { name: 'offset 99900', url: 'http://localhost:3001/api/logs?limit=100&offset=99900' },
    { name: 'severity + offset 50000', url: 'http://localhost:3001/api/logs?limit=100&offset=50000&severity=info' },
    { name: 'selective substring + offset 100', url: 'http://localhost:3001/api/logs?limit=100&offset=100&q=alice' },
    { name: 'non-selective substring + offset 50000', url: 'http://localhost:3001/api/logs?limit=100&offset=50000&q=user' }
  ];
  
  for (const t of tests) {
    let times = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(t.url);
      times.push(res.time);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)];
    console.log(`${t.name}: p95 = ${p95}ms`);
    require('fs').appendFileSync('test-api-result.txt', `${t.name}: p95 = ${p95}ms\n`);
  }
}

test().catch(console.error);