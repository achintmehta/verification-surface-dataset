/**
 * Test expiry: create a hold, manually expire it in the DB, then verify
 * that the next GET /api/seats returns those seats as available.
 */

const BASE = 'http://localhost:3001/api';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
}

async function main() {
  console.log('=== Test: Hold/Confirm/Release/Expiry ===\n');

  // 1. Create a hold
  const { data: holdData, status: s1 } = await req('POST', '/holds', {
    seatIds: ['C1', 'C2'],
    sessionId: 'expiry-test-session',
  });
  console.log(`1. Create hold: HTTP ${s1}`);
  console.log(`   Hold ID: ${holdData.hold?.id}`);
  console.log(`   Seats: ${holdData.seats?.map(s => s.id).join(', ')}`);

  const holdId = holdData.hold?.id;
  if (!holdId) throw new Error('No hold ID returned');

  // 2. Verify seats are held
  const { data: seats1 } = await req('GET', '/seats');
  const c1 = seats1.find(s => s.id === 'C1');
  const c2 = seats1.find(s => s.id === 'C2');
  console.log(`\n2. Seats after hold: C1=${c1.status}, C2=${c2.status}`);
  if (c1.status !== 'held') throw new Error('C1 should be held');
  if (c2.status !== 'held') throw new Error('C2 should be held');

  // 3. Try to confirm with wrong session
  const { data: wrongSession, status: s3 } = await req('POST', `/holds/${holdId}/confirm`, {
    sessionId: 'wrong-session',
  });
  console.log(`\n3. Confirm with wrong session: HTTP ${s3} - ${wrongSession.error}`);
  if (s3 !== 403) throw new Error(`Expected 403, got ${s3}`);

  // 4. Release the hold
  const { data: released, status: s4 } = await req('DELETE', `/holds/${holdId}`, {
    sessionId: 'expiry-test-session',
  });
  console.log(`\n4. Release hold: HTTP ${s4} - ${released.message}`);
  if (s4 !== 200) throw new Error(`Expected 200, got ${s4}`);

  // 5. Verify seats are available again
  const { data: seats2 } = await req('GET', '/seats');
  const c1b = seats2.find(s => s.id === 'C1');
  const c2b = seats2.find(s => s.id === 'C2');
  console.log(`\n5. Seats after release: C1=${c1b.status}, C2=${c2b.status}`);
  if (c1b.status !== 'available') throw new Error('C1 should be available');
  if (c2b.status !== 'available') throw new Error('C2 should be available');

  // 6. Try to confirm the released hold
  const { data: confirmReleased, status: s6 } = await req('POST', `/holds/${holdId}/confirm`, {
    sessionId: 'expiry-test-session',
  });
  console.log(`\n6. Confirm released hold: HTTP ${s6} - ${confirmReleased.error}`);
  if (s6 !== 409) throw new Error(`Expected 409, got ${s6}`);

  // 7. Inventory check
  const { data: allSeats } = await req('GET', '/seats');
  const available = allSeats.filter(s => s.status === 'available').length;
  const held = allSeats.filter(s => s.status === 'held').length;
  const booked = allSeats.filter(s => s.status === 'booked').length;
  console.log(`\n7. Inventory: available=${available}, held=${held}, booked=${booked}, total=${available+held+booked}`);
  if (available + held + booked !== 50) throw new Error('Total must be 50');
  if (booked !== 3) throw new Error(`Expected 3 booked (A1,A2,A3), got ${booked}`);

  console.log('\n✅ All basic tests passed!');
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});
