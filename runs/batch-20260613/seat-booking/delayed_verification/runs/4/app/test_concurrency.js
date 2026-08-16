/**
 * Concurrency test: fire N simultaneous hold requests for the same seat.
 * Exactly one should succeed; all others should get 409.
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
  console.log('=== Concurrency Test ===\n');

  // Fire 10 simultaneous hold requests for the same seat D1
  const N = 10;
  const seatId = 'D1';

  console.log(`Firing ${N} simultaneous hold requests for seat ${seatId}...`);

  const promises = Array.from({ length: N }, (_, i) =>
    req('POST', '/holds', {
      seatIds: [seatId],
      sessionId: `concurrent-session-${i}`,
    })
  );

  const results = await Promise.all(promises);

  const successes = results.filter(r => r.status === 201);
  const conflicts = results.filter(r => r.status === 409);
  const errors = results.filter(r => r.status !== 201 && r.status !== 409);

  console.log(`Results: ${successes.length} success, ${conflicts.length} conflict (409), ${errors.length} error`);

  if (successes.length !== 1) {
    throw new Error(`Expected exactly 1 success, got ${successes.length}`);
  }
  if (conflicts.length !== N - 1) {
    throw new Error(`Expected ${N-1} conflicts, got ${conflicts.length}`);
  }
  if (errors.length !== 0) {
    console.error('Unexpected errors:', errors);
    throw new Error('Got unexpected errors');
  }

  console.log(`✅ Exactly 1 hold succeeded for seat ${seatId}`);

  // Verify inventory
  const { data: allSeats } = await req('GET', '/seats');
  const d1 = allSeats.find(s => s.id === seatId);
  console.log(`\nSeat ${seatId} status: ${d1.status} (hold_id: ${d1.hold_id})`);

  const available = allSeats.filter(s => s.status === 'available').length;
  const held = allSeats.filter(s => s.status === 'held').length;
  const booked = allSeats.filter(s => s.status === 'booked').length;
  console.log(`Inventory: available=${available}, held=${held}, booked=${booked}, total=${available+held+booked}`);

  if (available + held + booked !== 50) throw new Error('Inventory mismatch!');
  console.log('✅ Inventory is correct');

  // Now test: 10 simultaneous requests for DIFFERENT seats - all should succeed
  console.log('\n--- Test: 10 simultaneous holds for different seats ---');
  const differentSeats = ['E1','E2','E3','E4','E5','E6','E7','E8','E9','E10'];
  const promises2 = differentSeats.map((seat, i) =>
    req('POST', '/holds', {
      seatIds: [seat],
      sessionId: `diff-session-${i}`,
    })
  );

  const results2 = await Promise.all(promises2);
  const successes2 = results2.filter(r => r.status === 201);
  const conflicts2 = results2.filter(r => r.status === 409);
  console.log(`Results: ${successes2.length} success, ${conflicts2.length} conflict`);
  if (successes2.length !== 10) throw new Error(`Expected 10 successes, got ${successes2.length}`);
  console.log('✅ All 10 different-seat holds succeeded');

  // Inventory check again
  const { data: allSeats2 } = await req('GET', '/seats');
  const av2 = allSeats2.filter(s => s.status === 'available').length;
  const h2 = allSeats2.filter(s => s.status === 'held').length;
  const b2 = allSeats2.filter(s => s.status === 'booked').length;
  console.log(`Final inventory: available=${av2}, held=${h2}, booked=${b2}, total=${av2+h2+b2}`);
  if (av2 + h2 + b2 !== 50) throw new Error('Inventory mismatch!');
  console.log('✅ Final inventory correct');

  console.log('\n✅ All concurrency tests passed!');
}

main().catch(err => {
  console.error('❌ Concurrency test failed:', err.message);
  process.exit(1);
});
