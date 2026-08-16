import http from 'http';

http.get('http://localhost:3000/api/events?start=2026-06-15T00:00:00Z&end=2026-06-22T00:00:00Z', (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log(data));
});
