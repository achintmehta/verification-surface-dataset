const http = require('http');

async function fetchLogs(offset, limit, severity, q) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let url = `http://localhost:3001/api/logs?offset=${offset}&limit=${limit}`;
    if (severity) url += `&severity=${severity}`;
    if (q) url += `&q=${q}`;
    
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve(Date.now() - start);
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log("Testing offset 0...");
  for(let i=0; i<5; i++) console.log(await fetchLogs(0, 100));
  
  console.log("Testing offset 50000...");
  for(let i=0; i<5; i++) console.log(await fetchLogs(50000, 100));
  
  console.log("Testing offset 99900...");
  for(let i=0; i<5; i++) console.log(await fetchLogs(99900, 100));
  
  console.log("Testing severity filter at deep offset...");
  for(let i=0; i<5; i++) console.log(await fetchLogs(20000, 100, 'info'));
  
  console.log("Testing substring filter at deep offset...");
  for(let i=0; i<5; i++) console.log(await fetchLogs(10000, 100, '', 'user'));
}

run();
