// Lightweight, dependency-free verification of the correctness-critical
// guarantees. Run with: `node backend/test/concurrency.test.js`
//
// Uses an in-memory PGLite (memory://) so it does not touch persisted data.

import assert from 'node:assert/strict';
import process from 'node:process';

// Point config at an in-memory db before importing modules that read it.
process.env.PGLITE_DIR = 'memory://';
process.env.HOLD_TTL_MS = '400'; // short TTL so expiry tests are fast
process.env.SEAT_ROWS = '2';
process.env.SEATS_PER_ROW = '5';

const { initDb, getDb } = await import('../src/db.js');
const {
  getSeats,
  getInventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpiredHolds,
  BookingError,
} = await import('../src/booking.js');

await initDb();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function firstAvailableIds(seats, n) {
  return seats.filter((s) => s.status === 'available').slice(0, n).map((s) => s.id);
}

async function assertInventoryBalances() {
  const inv = await getInventory();
  assert.equal(
    inv.available + inv.held + inv.booked,
    inv.total,
    `inventory must balance: ${JSON.stringify(inv)}`,
  );
  return inv;
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  \u2713 ${name}`);
  } catch (e) {
    console.error(`  \u2717 ${name}`);
    console.error('    ', e.message);
    process.exitCode = 1;
  }
}

console.log('Running seat-booking correctness tests\n');

// 1. Concurrent holds for the same seats: exactly one succeeds.
await test('concurrent holds for same seats: exactly one wins (all-or-nothing)', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 3);

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, i) => createHold(target, `sess-${i}`)),
  );

  const wins = results.filter((r) => r.status === 'fulfilled');
  const losses = results.filter((r) => r.status === 'rejected');

  assert.equal(wins.length, 1, 'exactly one hold should succeed');
  for (const l of losses) {
    assert.ok(l.reason instanceof BookingError, 'losers throw BookingError');
    assert.equal(l.reason.status, 409, 'losers get 409');
  }
  await assertInventoryBalances();
});

// 2. Active hold blocks others.
await test('active hold blocks other holds for those seats', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 2);
  await createHold(target, 'owner');
  await assert.rejects(() => createHold(target, 'other'), (e) => e.status === 409);
  await assertInventoryBalances();
});

// 3. Expiry frees seats automatically.
await test('hold expires after TTL and seats become available', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 1);
  await createHold(target, 'temp');

  // Held now.
  let after = await getSeats();
  assert.equal(after.find((s) => s.id === target[0]).status, 'held');

  await sleep(550); // > TTL
  await sweepExpiredHolds();

  after = await getSeats();
  assert.equal(after.find((s) => s.id === target[0]).status, 'available');
  await assertInventoryBalances();
});

// 4. Confirm books seats; idempotent on repeat.
await test('confirm books seats and is idempotent', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 2);
  const hold = await createHold(target, 'buyer');

  const c1 = await confirmHold(hold.holdId);
  assert.equal(c1.status, 'confirmed');
  assert.deepEqual([...c1.seatIds].sort(), [...target].sort());
  assert.equal(c1.idempotent, false);

  const c2 = await confirmHold(hold.holdId);
  assert.equal(c2.status, 'confirmed');
  assert.equal(c2.idempotent, true);
  assert.deepEqual([...c2.seatIds].sort(), [...target].sort());

  // Booked count increased by exactly the number of seats (no double-book).
  const after = await getSeats();
  for (const id of target) {
    assert.equal(after.find((s) => s.id === id).status, 'booked');
  }
  await assertInventoryBalances();
});

// 5. Confirming an expired hold fails and books nothing.
await test('confirming an expired hold fails and books nothing', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 1);
  const hold = await createHold(target, 'slowpoke');

  await sleep(550);
  await assert.rejects(() => confirmHold(hold.holdId), (e) => e.status === 410 || e.status === 409);

  const after = await getSeats();
  assert.equal(after.find((s) => s.id === target[0]).status, 'available');
  await assertInventoryBalances();
});

// 6. Confirming an unknown hold fails.
await test('confirming an unknown hold fails', async () => {
  await assert.rejects(
    () => confirmHold('00000000-0000-0000-0000-000000000000'),
    (e) => e.status === 404,
  );
});

// 7. Release returns seats to available.
await test('release returns seats to available', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 2);
  const hold = await createHold(target, 'releaser');
  const r = await releaseHold(hold.holdId);
  assert.deepEqual([...r.releasedSeatIds].sort(), [...target].sort());

  const after = await getSeats();
  for (const id of target) {
    assert.equal(after.find((s) => s.id === id).status, 'available');
  }
  await assertInventoryBalances();
});

// 8. A confirmed seat is never re-bookable / re-holdable.
await test('booked seats cannot be held again', async () => {
  const seats = await getSeats();
  const target = firstAvailableIds(seats, 1);
  const hold = await createHold(target, 'final');
  await confirmHold(hold.holdId);
  await assert.rejects(() => createHold(target, 'thief'), (e) => e.status === 409);
  await assertInventoryBalances();
});

// 9. Partial-conflict hold acquires nothing (all-or-nothing).
await test('partial conflict acquires no seats', async () => {
  const seats = await getSeats();
  const avail = firstAvailableIds(seats, 3);
  assert.ok(avail.length >= 3, 'need at least 3 free seats for this test');

  // Hold the first one.
  const blocker = await createHold([avail[0]], 'blocker');

  const before = await getInventory();
  // Request all three (one already held) -> must fail and acquire none.
  await assert.rejects(() => createHold(avail, 'greedy'), (e) => {
    return e.status === 409 && e.extra.conflictingSeatIds.includes(avail[0]);
  });

  const afterInv = await getInventory();
  // The two free seats must still be available (not held by greedy).
  const after = await getSeats();
  assert.equal(after.find((s) => s.id === avail[1]).status, 'available');
  assert.equal(after.find((s) => s.id === avail[2]).status, 'available');
  assert.equal(afterInv.held, before.held, 'no extra seats held');

  await releaseHold(blocker.holdId);
  await assertInventoryBalances();
});

console.log(`\n${passed} tests passed.`);
if (process.exitCode) console.error('Some tests FAILED.');
else console.log('All correctness checks passed. \u2705');

await getDb().close?.();
