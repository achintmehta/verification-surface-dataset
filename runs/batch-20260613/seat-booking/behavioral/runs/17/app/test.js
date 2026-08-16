async function run() {
  const sessionId1 = 'session1';
  const sessionId2 = 'session2';

  // Hold seat A1 concurrently
  const p1 = fetch('http://localhost:3000/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['A1'], sessionId: sessionId1 })
  });

  const p2 = fetch('http://localhost:3000/api/holds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: ['A1'], sessionId: sessionId2 })
  });

  const [res1, res2] = await Promise.all([p1, p2]);
  console.log('res1 status:', res1.status);
  console.log('res2 status:', res2.status);

  const data1 = await res1.json();
  const data2 = await res2.json();
  console.log('data1:', data1);
  console.log('data2:', data2);
}

run();
