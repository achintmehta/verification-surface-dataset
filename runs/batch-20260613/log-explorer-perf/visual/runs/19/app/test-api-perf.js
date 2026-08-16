const fetch = require('node-fetch');

async function measure(url) {
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = Date.now();
    const res = await fetch(url);
    await res.json();
    times.push(Date.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`${url} - p95: ${p95}ms`);
}

async function run() {
  await measure('http://localhost:3001/api/logs?limit=100&offset=0');
  await measure('http://localhost:3001/api/logs?limit=100&offset=50000');
  await measure('http://localhost:3001/api/logs?limit=100&offset=99900');
  
  await measure('http://localhost:3001/api/logs?limit=100&offset=50000&severity=error');
  await measure('http://localhost:3001/api/logs?limit=100&offset=50000&q=99999'); // selective
  await measure('http://localhost:3001/api/logs?limit=100&offset=50000&q=service'); // non-selective
}

run();