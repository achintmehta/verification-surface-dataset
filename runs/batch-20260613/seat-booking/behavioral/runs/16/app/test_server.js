const { app, db, initDb } = require('./server/index.js');
const http = require('http');

async function runTest() {
  // Wait a bit for initDb to finish from server/index.js
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  const server = http.createServer(app);
  server.listen(3001, async () => {
    console.log('Test server running on 3001');
    
    try {
      // 1. Get seats
      let res = await fetch('http://localhost:3001/api/seats');
      let seats = await res.json();
      console.log('Total seats:', seats.length);

      // 2. Hold seats
      res = await fetch('http://localhost:3001/api/holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds: ['A1', 'A2'], sessionId: 'test-session' })
      });
      let hold = await res.json();
      console.log('Hold response:', hold);

      // 3. Confirm hold
      res = await fetch(`http://localhost:3001/api/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test-session' })
      });
      let confirm = await res.json();
      console.log('Confirm response:', confirm);

      // 4. Idempotent confirm
      res = await fetch(`http://localhost:3001/api/holds/${hold.holdId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'test-session' })
      });
      let confirm2 = await res.json();
      console.log('Confirm 2 response:', confirm2);

      // 5. Hold unavailable seats
      res = await fetch('http://localhost:3001/api/holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds: ['A1', 'A3'], sessionId: 'test-session' })
      });
      console.log('Hold unavailable status:', res.status);
      let conflict = await res.json();
      console.log('Conflict response:', conflict);

    } catch (err) {
      console.error(err);
    } finally {
      server.close();
      process.exit(0);
    }
  });
}

runTest();
