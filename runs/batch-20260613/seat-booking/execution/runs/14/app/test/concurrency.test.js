import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';

// Use a temp DB dir and tiny TTL for expiry tests.
process.env.DB_DIR = './test-pgdata';
process.env.HOLD_TTL_MS = '500';
// Larger seat map so the distinct seat ids used across tests all exist.
process.env.ROWS = '20';
process.env.SEATS_PER_ROW = '10';

const { initDb } = await import('../server/db.js');
const booking = await import('../server/booking.js');

before(async () => {
  await rm('./test-pgdata', { recursive: true, force: true });
  await initDb();
});

after(async () => {
  await rm('./test-pgdata', { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function assertInventoryBalances() {
  const inv = await booking.getInventory();
  assert.equal(
    inv.available + inv.held + inv.booked,
    inv.total,
    'inventory must balance'
  );
  return inv;
}

test('basic hold + confirm books seats exactly once', async () => {
  const hold = await booking.createHold([1, 2, 3], 'sessA');
  assert.ok(hold.ok, 'hold should succeed');
  assert.deepEqual(hold.hold.seatIds.sort((a, b) => a - b), [1, 2, 3]);

  const confirm = await booking.confirmHold(hold.hold.id);
  assert.ok(confirm.ok);
  assert.equal(confirm.idempotent, false);
  assert.deepEqual(confirm.booking.seatIds.sort((a, b) => a - b), [1, 2, 3]);

  const seats = await booking.getSeats();
  for (const id of [1, 2, 3]) {
    const s = seats.find((x) => x.id === id);
    assert.equal(s.status, 'booked');
    assert.equal(s.bookedBy, 'sessA');
  }
  await assertInventoryBalances();
});

test('confirmation is idempotent', async () => {
  const hold = await booking.createHold([4, 5], 'sessB');
  assert.ok(hold.ok);
  const c1 = await booking.confirmHold(hold.hold.id);
  const c2 = await booking.confirmHold(hold.hold.id);
  const c3 = await booking.confirmHold(hold.hold.id);
  assert.ok(c1.ok && c2.ok && c3.ok);
  assert.equal(c2.idempotent, true);
  assert.equal(c3.idempotent, true);
  assert.deepEqual(c2.booking.seatIds.sort((a, b) => a - b), [4, 5]);

  const inv = await assertInventoryBalances();
  // Only 5 seats booked so far (1,2,3,4,5)
  assert.equal(inv.booked, 5);
});

test('held seats block other holds (all-or-nothing 409)', async () => {
  const h = await booking.createHold([10, 11], 'sessC');
  assert.ok(h.ok);

  // Overlapping request must fail and acquire nothing.
  const conflict = await booking.createHold([11, 12], 'sessD');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'CONFLICT');
  assert.deepEqual(conflict.conflicts, [11]);

  // Seat 12 must remain available (all-or-nothing).
  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 12).status, 'available');
  await assertInventoryBalances();
});

test('many concurrent holds for the same seat: exactly one wins', async () => {
  const SEAT = 20;
  const N = 50;
  const attempts = Array.from({ length: N }, (_, i) =>
    booking.createHold([SEAT], `race-${i}`)
  );
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'exactly one hold should win');

  const losers = results.filter((r) => !r.ok);
  assert.equal(losers.length, N - 1);
  for (const l of losers) {
    assert.equal(l.code, 'CONFLICT');
    assert.deepEqual(l.conflicts, [SEAT]);
  }
  await assertInventoryBalances();
});

test('concurrent confirms of one hold book exactly once', async () => {
  const hold = await booking.createHold([30, 31], 'sessE');
  assert.ok(hold.ok);

  const confirms = await Promise.all(
    Array.from({ length: 20 }, () => booking.confirmHold(hold.hold.id))
  );
  for (const c of confirms) assert.ok(c.ok);
  const nonIdempotent = confirms.filter((c) => !c.idempotent);
  assert.equal(nonIdempotent.length, 1, 'exactly one real booking');

  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 30).status, 'booked');
  assert.equal(seats.find((s) => s.id === 31).status, 'booked');
  await assertInventoryBalances();
});

test('expired holds free their seats automatically', async () => {
  const hold = await booking.createHold([40, 41], 'sessF');
  assert.ok(hold.ok);

  // TTL is 500ms in tests.
  await sleep(700);

  // Reading seats should report them available (lazy expiry).
  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 40).status, 'available');
  assert.equal(seats.find((s) => s.id === 41).status, 'available');

  // Another user can now hold them.
  const h2 = await booking.createHold([40, 41], 'sessG');
  assert.ok(h2.ok);
  await assertInventoryBalances();
});

test('confirming an expired hold fails and books nothing', async () => {
  const hold = await booking.createHold([50, 51], 'sessH');
  assert.ok(hold.ok);
  await sleep(700);

  const confirm = await booking.confirmHold(hold.hold.id);
  assert.equal(confirm.ok, false);
  assert.equal(confirm.code, 'HOLD_EXPIRED');

  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 50).status, 'available');
  assert.equal(seats.find((s) => s.id === 51).status, 'available');
  await assertInventoryBalances();
});

test('confirming an unknown hold fails', async () => {
  const confirm = await booking.confirmHold('does-not-exist');
  assert.equal(confirm.ok, false);
  assert.equal(confirm.code, 'NOT_FOUND');
});

test('release returns seats to available', async () => {
  const hold = await booking.createHold([60, 61], 'sessI');
  assert.ok(hold.ok);
  const rel = await booking.releaseHold(hold.hold.id);
  assert.ok(rel.ok);
  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 60).status, 'available');
  assert.equal(seats.find((s) => s.id === 61).status, 'available');
  await assertInventoryBalances();
});

test('cannot release an already-confirmed hold', async () => {
  const hold = await booking.createHold([70], 'sessJ');
  assert.ok(hold.ok);
  await booking.confirmHold(hold.hold.id);
  const rel = await booking.releaseHold(hold.hold.id);
  assert.equal(rel.ok, false);
  assert.equal(rel.code, 'ALREADY_CONFIRMED');
  const seats = await booking.getSeats();
  assert.equal(seats.find((s) => s.id === 70).status, 'booked');
});

test('high-volume mixed operations keep inventory exact', async () => {
  const ops = [];
  for (let i = 0; i < 40; i++) {
    const base = 100 + ((i * 3) % 30);
    ops.push(
      (async () => {
        const h = await booking.createHold([base], `mix-${i}`);
        if (h.ok) {
          if (i % 2 === 0) await booking.confirmHold(h.hold.id);
          else await booking.releaseHold(h.hold.id);
        }
      })()
    );
  }
  await Promise.all(ops);
  await assertInventoryBalances();
});
