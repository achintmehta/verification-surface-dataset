const http = require('http');

http.get('http://localhost:3001/api/summary', (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log('Summary:', data);
  });
}).on('error', (err) => {
  console.log('Error:', err.message);
});
