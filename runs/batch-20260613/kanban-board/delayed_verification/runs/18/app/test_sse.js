import http from 'http';

const req = http.get('http://localhost:3000/api/stream', (res) => {
  res.on('data', (chunk) => {
    console.log(chunk.toString());
  });
});

setTimeout(() => {
  const postReq = http.request('http://localhost:3000/api/cards', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, (res) => {
    res.on('data', () => {});
  });
  postReq.write(JSON.stringify({ columnId: 'col-1', text: 'Test Card 3' }));
  postReq.end();
}, 1000);

setTimeout(() => {
  process.exit(0);
}, 2000);
