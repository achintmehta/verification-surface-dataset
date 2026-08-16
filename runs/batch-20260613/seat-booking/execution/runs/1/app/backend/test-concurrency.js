/**
 * Concurrency test: fire N simultaneous hold requests for the same seat.
 * Exactly one should succeed; all others should get 409.
 */

const BASE = 'http://localhost:3001';
const SEAT_IDS = ['E1', 'E2'];
const CONCURRENT = 10;

async function tryHold(sessionId) {
  const res = await fetch(`${BASE}/api/holds`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seatIds: SEAT_IDS, sessionId }),
  });
  return { status: res.status, body: await res.json(), sessionId };
}

async function main() {
  console.log(`Firing ${CONCURRENT} concurrent hold requests for seats ${SEAT_IDS.join(', ')}…\n`);

  const promises = Array.from({ length: CONCURRENT }, (_, i) =>
    tryHold(`concurrent-session-${i}`)
  );

  const results = await Promise.all(promises);

  const successes = results.filter((r) => r.status === 201);
  const conflicts = results.filter((r) => r.status === 409);
  const errors    = results.filter((r) => r.status !== 201 && r.status !== 409);

  console.log(`Results:`);
  console.log(`  Successes (201): ${successes.length}`);
  console.log(`  Conflicts (409): ${conflicts.length}`);
  console.log(`  Errors:          ${errors.length}`);

  if (successes.length === 1) {
    console.log(`\n✅ PASS: Exactly one hold succeeded.`);
    console.log(`   Winner: ${successes[0].sessionId}`);
    console.log(`   Hold ID: ${successes[0].body.id}`);
  } else {
    console.log(`\n❌ FAIL: Expected exactly 1 success, got ${successes.length}.`);
    for (const s of successes) {
      console.log(`   - ${s.sessionId}: ${s.body.id}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errors) {
      console.log(`  ${e.sessionId}: ${e.status} ${JSON.stringify(e.body)}`);
    }
  }

  // Verify inventory
  const seatsRes = await fetch(`${BASE}/api/seats`);
  const seats = await seatsRes.json();
  const counts = { available: 0, held: 0, booked: 0 };
  for (const s of seats) counts[s.status]++;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`\nInventory: available=${counts.available} held=${counts.held} booked=${counts.booked} total=${total}`);
  console.log(total === 50 ? '✅ Inventory balanced.' : '❌ Inventory UNBALANCED!');
}

main().catch(console.error);
