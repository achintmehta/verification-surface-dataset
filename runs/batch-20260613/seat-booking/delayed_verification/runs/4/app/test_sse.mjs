/**
 * Test SSE broadcasts: connect to SSE, then create a hold and verify
 * the seatUpdate event is received.
 */

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function req(method, urlPath, body) {
  const res = await fetch(`http://localhost:3001/api${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log('=== SSE Broadcast Test ===\n');

  const receivedEvents = [];
  let connectedSeats = null;

  // Connect to SSE stream
  console.log('Connecting to SSE stream...');
  const controller = new AbortController();
  
  const ssePromise = (async () => {
    const res = await fetch('http://localhost:3001/api/stream', {
      signal: controller.signal,
    });
    
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line
      
      let eventType = null;
      let eventData = null;
      
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          eventData = line.slice(6).trim();
        } else if (line === '' && eventType && eventData) {
          const parsed = JSON.parse(eventData);
          if (eventType === 'connected') {
            connectedSeats = parsed;
            console.log(`Received 'connected' event with ${parsed.length} seats`);
          } else if (eventType === 'seatUpdate') {
            receivedEvents.push(parsed);
            console.log(`Received 'seatUpdate' event with ${parsed.length} seat(s): ${parsed.map(s => `${s.id}=${s.status}`).join(', ')}`);
          }
          eventType = null;
          eventData = null;
        }
      }
    }
  })();

  // Wait for connection
  await sleep(500);
  if (!connectedSeats) throw new Error('Did not receive connected event');
  console.log('✅ Connected event received\n');

  // Find two available seats to use
  const availableSeats = connectedSeats.filter(s => s.status === 'available').slice(0, 2);
  if (availableSeats.length < 2) throw new Error('Not enough available seats for test');
  const [seat1, seat2] = availableSeats;

  // Create a hold - should trigger seatUpdate
  console.log(`Creating hold for ${seat1.id}, ${seat2.id}...`);
  const { data: holdData, status: s1 } = await req('POST', '/holds', {
    seatIds: [seat1.id, seat2.id],
    sessionId: 'sse-test-session',
  });
  if (s1 !== 201) throw new Error(`Expected 201, got ${s1}`);
  const holdId = holdData.hold.id;
  console.log(`Hold created: ${holdId}`);

  // Wait for SSE event
  await sleep(300);
  
  const holdEvent = receivedEvents.find(e => e.some(s => s.id === seat1.id && s.status === 'held'));
  if (!holdEvent) throw new Error('Did not receive seatUpdate for hold');
  console.log('✅ Received seatUpdate for hold');

  // Confirm the hold - should trigger another seatUpdate
  console.log('\nConfirming hold...');
  const { data: confirmData, status: s2 } = await req('POST', `/holds/${holdId}/confirm`, {
    sessionId: 'sse-test-session',
  });
  if (s2 !== 200) throw new Error(`Expected 200, got ${s2}`);

  await sleep(300);

  const bookEvent = receivedEvents.find(e => e.some(s => s.id === seat1.id && s.status === 'booked'));
  if (!bookEvent) throw new Error('Did not receive seatUpdate for booking');
  console.log('✅ Received seatUpdate for booking');

  // Find another available seat for release test
  const { data: freshSeats } = await req('GET', '/seats');
  const seat3 = freshSeats.find(s => s.status === 'available');
  if (!seat3) throw new Error('No available seat for release test');

  // Release a hold - should trigger seatUpdate
  console.log(`\nCreating and releasing hold for ${seat3.id}...`);
  const { data: holdData2, status: s3 } = await req('POST', '/holds', {
    seatIds: [seat3.id],
    sessionId: 'sse-release-session',
  });
  if (s3 !== 201) throw new Error(`Expected 201, got ${s3}`);
  const holdId2 = holdData2.hold.id;

  await sleep(200);

  const { status: s4 } = await req('DELETE', `/holds/${holdId2}`, {
    sessionId: 'sse-release-session',
  });
  if (s4 !== 200) throw new Error(`Expected 200, got ${s4}`);

  await sleep(300);

  const releaseEvent = receivedEvents.find(e => e.some(s => s.id === seat3.id && s.status === 'available'));
  if (!releaseEvent) throw new Error('Did not receive seatUpdate for release');
  console.log('✅ Received seatUpdate for release');

  // Stop SSE connection
  controller.abort();
  await ssePromise.catch(() => {}); // swallow AbortError

  console.log(`\nTotal SSE events received: ${receivedEvents.length}`);
  console.log('\n✅ All SSE tests passed!');
}

main().catch(err => {
  console.error('❌ SSE test failed:', err.message);
  process.exit(1);
});
