import http from 'http';

const req = http.get('http://localhost:3000/api/stream', (res) => {
  res.on('data', (chunk) => {
    console.log(chunk.toString());
  });
});

setTimeout(() => {
  const postData = JSON.stringify({ columnId: 1, text: 'SSE Test' });
  const req2 = http.request('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  });
  req2.write(postData);
  req2.end();
}, 1000);

setTimeout(() => {
  process.exit(0);
}, 2000);
