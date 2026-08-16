import { spawn } from 'child_process';

const server = spawn('node', ['server/index.js']);

server.stdout.on('data', (data) => {
  console.log(`stdout: ${data}`);
});

server.stderr.on('data', (data) => {
  console.error(`stderr: ${data}`);
});

setTimeout(async () => {
  try {
    const res = await fetch('http://localhost:3001/api/seats');
    const seats = await res.json();
    console.log('Seats:', seats.length);
    
    // Test hold
    const holdRes = await fetch('http://localhost:3001/api/holds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seatIds: ['A1', 'A2'], sessionId: 'test-session' })
    });
    const holdData = await holdRes.json();
    console.log('Hold:', holdData);
    
    // Test confirm
    const confirmRes = await fetch(`http://localhost:3001/api/holds/${holdData.holdId}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'test-session' })
    });
    const confirmData = await confirmRes.json();
    console.log('Confirm:', confirmData);
    
  } catch (err) {
    console.error(err);
  } finally {
    server.kill();
  }
}, 2000);
