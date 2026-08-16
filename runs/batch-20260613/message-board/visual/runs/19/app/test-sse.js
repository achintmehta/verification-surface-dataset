import http from 'http';

const req = http.get('http://localhost:3000/api/stream', (res) => {
  res.on('data', (chunk) => {
    console.log(chunk.toString());
  });
});

setTimeout(() => {
  req.destroy();
}, 2000);
