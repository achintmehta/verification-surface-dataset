const http = require('http');

function fetch(url) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const end = Date.now();
        resolve({ time: end - start, data: JSON.parse(data) });
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log("Testing offset 0...");
  let res = await fetch('http://localhost:3000/api/logs?offset=0&limit=100');
  console.log(`Offset 0: ${res.time}ms`);

  console.log("Testing offset 50000...");
  res = await fetch('http://localhost:3000/api/logs?offset=50000&limit=100');
  console.log(`Offset 50000: ${res.time}ms`);

  console.log("Testing offset 99900...");
  res = await fetch('http://localhost:3000/api/logs?offset=99900&limit=100');
  console.log(`Offset 99900: ${res.time}ms`);

  console.log("Testing severity filter...");
  res = await fetch('http://localhost:3000/api/logs?severity=error&offset=4000&limit=100');
  console.log(`Severity error offset 4000: ${res.time}ms`);

  console.log("Testing selective substring...");
  res = await fetch('http://localhost:3000/api/logs?q=timeout&offset=0&limit=100');
  console.log(`Substring 'timeout' offset 0: ${res.time}ms`);

  console.log("Testing non-selective substring...");
  res = await fetch('http://localhost:3000/api/logs?q=user&offset=50000&limit=100');
  console.log(`Substring 'user' offset 50000: ${res.time}ms`);
}

run();