const http = require('http');

http.get('http://localhost:3001/api/logs?offset=0&limit=5', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('API Response:', JSON.parse(data));
  });
});
