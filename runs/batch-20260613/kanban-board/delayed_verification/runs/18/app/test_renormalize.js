import http from 'http';

async function moveCard(id, columnId, beforeId, afterId) {
  return new Promise((resolve) => {
    const req = http.request(`http://localhost:3000/api/cards/${id}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.write(JSON.stringify({ columnId, beforeId, afterId }));
    req.end();
  });
}

async function run() {
  // Move card 2 before card 3 multiple times to exhaust precision
  // Wait, we can just move it to the same place to trigger collision
  const res = await moveCard('2517a8ae-2b50-4c3b-95ee-efec864feb90', 'col-2', 'c75e2799-6ed7-4e20-98ba-f8d725effad4', null);
  console.log(res);
}

run();
