import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Configure an isolated, fresh PGLite directory + short TTL BEFORE importing
// the modules that read config at import time.
process.env.DATA_DIR = join(mkdtempSync(join(tmpdir(), 'seats-')), 'pg');
process.env.HOLD_TTL_MS = '400';

const { initDb } = await import('../server/db.js');
const {
  listSeats,
  createHold,
  confirmHold,
  releaseHold,
  inventory,
  sweepExpired
} = await import('../server/seats.js');

await initDb();

const TOTAL = 50; // 5 rows x 10 seats default

function balanced(inv) {
  return inv.available + inv.held + inv.booked === inv.total;
}

test('seed creates fixed seat map, all available', async () => {
  const seats = await listSeats();
  assert.equal(seats.length, TOTAL);
  assert.ok(seats.every((s) => s.status === 'available'));
});

test('hold is all-or-nothing and exactly one of two racers wins', async () => {
  const seatIds = ['A1', 'A2', 'A3'];
  const [r1, r2] = await Promise.all([
    createHold(seatIds, 'sessionA'),
    createHold(seatIds, 'sessionB')
  ]);
  const successes = [r1, r2].filter((r) => r.ok);
  const failures = [r1, r2].filter((r) => !r.ok);
  assert.equal(successes.length, 1, 'exactly one hold succeeds');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].status, 409);
  assert.deepEqual(
    [...failures[0].conflictSeatIds].sort(),
    [...seatIds].sort()
  );

  // Inventory: 3 held, rest available.
  const inv = await inventory();
  assert.ok(balanced(inv));
  assert.equal(inv.held, 3);

  // Cleanup for later tests.
  await releaseHold(successes[0].hold.holdId);
});

test('massive concurrency: only one session books each contested seat', async () => {
  const target = ['B1', 'B2'];
  const attempts = [];
  for (let i = 0; i < 40; i++) {
    attempts.push(createHold(target, `racer-${i}`));
  }
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'only one of 40 racers acquires the seats');

  // Confirm the winner; verify no double-booking.
  const conf = await confirmHold(winners[0].hold.holdId);
  assert.ok(conf.ok);
  assert.deepEqual([...conf.booking.seatIds].sort(), [...target].sort());

  const seats = await listSeats();
  const booked = seats.filter((s) => s.status === 'booked');
  assert.equal(booked.length, 2);
  // All booked seats share the same bookedBy (single session).
  const owners = new Set(booked.map((s) => s.bookedBy));
  assert.equal(owners.size, 1);

  const inv = await inventory();
  assert.ok(balanced(inv));
});

test('active hold blocks others from holding the same seat', async () => {
  const r = await createHold(['C5'], 'holderX');
  assert.ok(r.ok);
  const blocked = await createHold(['C5'], 'holderY');
  assert.ok(!blocked.ok);
  assert.equal(blocked.status, 409);
  await releaseHold(r.hold.holdId);
});

test('confirmation is idempotent', async () => {
  const r = await createHold(['D1', 'D2'], 'idem');
  assert.ok(r.ok);
  const first = await confirmHold(r.hold.holdId);
  const second = await confirmHold(r.hold.holdId);
  assert.ok(first.ok && second.ok);
  assert.ok(second.alreadyConfirmed);
  assert.deepEqual(
    [...first.booking.seatIds].sort(),
    [...second.booking.seatIds].sort()
  );
  // Still exactly 2 booked seats from this hold.
  const seats = await listSeats();
  const mine = seats.filter((s) => s.bookedBy === r.hold.holdId);
  assert.equal(mine.length, 2);
});

test('confirming an unknown hold fails and books nothing', async () => {
  const before = await inventory();
  const res = await confirmHold('00000000-0000-0000-0000-000000000000');
  assert.ok(!res.ok);
  assert.equal(res.status, 410);
  const after = await inventory();
  assert.equal(before.booked, after.booked);
});

test('hold expires after TTL and seats become available again', async () => {
  const r = await createHold(['E1', 'E2', 'E3'], 'expiring');
  assert.ok(r.ok);
  let seats = await listSeats();
  assert.equal(seats.filter((s) => s.status === 'held' && s.holdId === r.hold.holdId).length, 3);

  // Wait beyond the (short) TTL.
  await new Promise((res) => setTimeout(res, 600));

  // Reading should report them available (lazy expiry).
  seats = await listSeats();
  for (const id of ['E1', 'E2', 'E3']) {
    assert.equal(seats.find((s) => s.id === id).status, 'available');
  }
});

test('confirming an expired hold fails and books nothing', async () => {
  const r = await createHold(['E4', 'E5'], 'expireConfirm');
  assert.ok(r.ok);
  await new Promise((res) => setTimeout(res, 600));
  const conf = await confirmHold(r.hold.holdId);
  assert.ok(!conf.ok);
  assert.equal(conf.status, 410);
  const seats = await listSeats();
  assert.ok(['E4', 'E5'].every((id) => seats.find((s) => s.id === id).status === 'available'));
});

test('release returns held seats to available', async () => {
  const r = await createHold(['A8', 'A9'], 'releaser');
  assert.ok(r.ok);
  const rel = await releaseHold(r.hold.holdId);
  assert.ok(rel.ok);
  const seats = await listSeats();
  assert.ok(['A8', 'A9'].every((id) => seats.find((s) => s.id === id).status === 'available'));
});

test('inventory always balances after mixed operations', async () => {
  await Promise.all([
    createHold(['A4'], 's1'),
    createHold(['A5'], 's2'),
    createHold(['A6', 'A7'], 's3')
  ]);
  await sweepExpired();
  const inv = await inventory();
  assert.ok(balanced(inv), `available+held+booked must equal total: ${JSON.stringify(inv)}`);
});
