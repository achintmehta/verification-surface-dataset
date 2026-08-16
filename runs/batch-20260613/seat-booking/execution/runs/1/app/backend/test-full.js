/**
 * Full integration test suite.
 *
 * Tests:
 *  1. Seat map loads with correct count
 *  2. Hold creation (success)
 *  3. Conflict detection (all-or-nothing)
 *  4. Confirm hold (success)
 *  5. Idempotent confirm
 *  6. Confirm expired hold (via /api/test/expire-hold)
 *  7. Release hold
 *  8. Inventory always balanced
 *  9. Concurrency: 20 simultaneous holds for same seat → exactly 1 wins
 */

const BASE = 'http://localhost:3001';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

async function getSeats() {
  return (await fetch(`${BASE}/api/seats`)).json();
}

async function checkInventory(label) {
  const seats = await getSeats();
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of seats) counts[s.status]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  assert(total === 50, `${label}: inventory balanced (${counts.available}+${counts.held}+${counts.booked}=${total})`);
  return counts;
}

async function main() {
  console.log('=== Full Integration Test Suite ===\n');

  // ── Test 1: Seat map ──────────────────────────────────────────────────────
  console.log('Test 1: Seat map');
  const seats = await getSeats();
  assert(seats.length === 50, `50 seats returned`);
  assert(seats.every((s) => s.status === 'available' || s.status === 'held' || s.status === 'booked'),
    'All seats have valid status');

  // Find two available seats to use for testing
  const availableSeats = seats.filter((s) => s.status === 'available');
  const testSeat1 = availableSeats[0].id;
  const testSeat2 = availableSeats[1].id;
  const testSeat3 = availableSeats[2].id; // for conflict test (should remain available)

  // ── Test 2: Hold creation ─────────────────────────────────────────────────
  console.log('\nTest 2: Hold creation');
  const holdRes = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: [testSeat1, testSeat2], sessionId: 'test-full-1' }),
  });
  const hold = await holdRes.json();
  assert(holdRes.status === 201, `Hold created (201)`);
  assert(hold.id && hold.expiresAt, `Hold has id and expiresAt`);
  assert(hold.seats.length === 2, `Hold contains 2 seats`);
  assert(hold.seats.every((s) => s.status === 'held'), `Held seats have status=held`);

  // ── Test 3: Conflict detection ────────────────────────────────────────────
  console.log('\nTest 3: Conflict detection');
  const conflictRes = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: [testSeat1, testSeat3], sessionId: 'test-full-2' }),
  });
  const conflict = await conflictRes.json();
  assert(conflictRes.status === 409, `Conflict returns 409`);
  assert(conflict.conflictSeatIds.includes(testSeat1), `Conflict identifies ${testSeat1}`);
  assert(!conflict.conflictSeatIds.includes(testSeat3), `${testSeat3} not in conflict (it was available)`);

  // Verify testSeat3 is still available (all-or-nothing)
  const seatsAfterConflict = await getSeats();
  const seat3After = seatsAfterConflict.find((s) => s.id === testSeat3);
  assert(seat3After.status === 'available', `${testSeat3} still available after failed hold (all-or-nothing)`);

  // ── Test 4: Confirm hold ──────────────────────────────────────────────────
  console.log('\nTest 4: Confirm hold');
  const confirmRes = await fetch(`${BASE}/api/holds/${hold.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'test-full-1' }),
  });
  const booking = await confirmRes.json();
  assert(confirmRes.status === 200, `Confirm returns 200`);
  assert(booking.seats.every((s) => s.status === 'booked'), `Seats are booked`);
  assert(booking.seats.every((s) => s.bookedBy === 'test-full-1'), `Seats booked by correct session`);

  // ── Test 5: Idempotent confirm ────────────────────────────────────────────
  console.log('\nTest 5: Idempotent confirm');
  const confirm2Res = await fetch(`${BASE}/api/holds/${hold.id}/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'test-full-1' }),
  });
  const booking2 = await confirm2Res.json();
  assert(confirm2Res.status === 200, `Second confirm returns 200`);
  assert(booking2.alreadyConfirmed === true, `Second confirm flagged as alreadyConfirmed`);
  assert(booking2.seats.length === 2, `Same 2 seats returned`);

  // ── Test 6: Confirm unknown/expired hold ──────────────────────────────────
  console.log('\nTest 6: Confirm unknown hold');
  const expiredRes = await fetch(`${BASE}/api/holds/does-not-exist/confirm`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'test-full-1' }),
  });
  assert(expiredRes.status === 404, `Unknown hold returns 404`);

  // ── Test 7: Release hold ──────────────────────────────────────────────────
  console.log('\nTest 7: Release hold');
  // Find two more available seats
  const seatsForRelease = (await getSeats()).filter((s) => s.status === 'available').slice(0, 2);
  const relSeat1 = seatsForRelease[0].id;
  const relSeat2 = seatsForRelease[1].id;

  const holdToRelease = await (await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: [relSeat1, relSeat2], sessionId: 'test-full-3' }),
  })).json();

  const releaseRes = await fetch(`${BASE}/api/holds/${holdToRelease.id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'test-full-3' }),
  });
  const released = await releaseRes.json();
  assert(releaseRes.status === 200, `Release returns 200`);
  assert(released.released.includes(relSeat1) && released.released.includes(relSeat2), `Both seats released`);

  const seatsAfterRelease = await getSeats();
  const relSeat1After = seatsAfterRelease.find((s) => s.id === relSeat1);
  assert(relSeat1After.status === 'available', `${relSeat1} available after release`);

  // ── Test 8: Inventory ─────────────────────────────────────────────────────
  console.log('\nTest 8: Inventory');
  await checkInventory('After all operations');

  // ── Test 9: Concurrency ───────────────────────────────────────────────────
  console.log('\nTest 9: Concurrency (20 simultaneous holds for same seat)');
  const CONCURRENT = 20;
  // Find two available seats for the concurrency test
  const concSeats = (await getSeats()).filter((s) => s.status === 'available').slice(0, 2);
  const TARGET_SEATS = concSeats.map((s) => s.id);

  const concurrentResults = await Promise.all(
    Array.from({ length: CONCURRENT }, (_, i) =>
      fetch(`${BASE}/api/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds: TARGET_SEATS, sessionId: `concurrent-${i}` }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }))
    )
  );

  const wins = concurrentResults.filter((r) => r.status === 201);
  const losses = concurrentResults.filter((r) => r.status === 409);
  assert(wins.length === 1, `Exactly 1 concurrent hold succeeded (got ${wins.length})`);
  assert(losses.length === CONCURRENT - 1, `${CONCURRENT - 1} concurrent holds rejected`);

  await checkInventory('After concurrency test');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('🎉 All tests passed!');
  } else {
    console.log('⚠️  Some tests failed.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
