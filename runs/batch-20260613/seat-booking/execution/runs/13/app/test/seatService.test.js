import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';

// Use a temp data dir and short TTL for fast expiry tests.
process.env.PGLITE_DIR = './pgdata-test';
process.env.HOLD_TTL_MS = '400';
process.env.SEAT_ROWS = '5';
process.env.SEATS_PER_ROW = '10';

rmSync('./pgdata-test', { recursive: true, force: true });

const { initDb, resetSeats, getDb } = await import('../server/db.js');
const {
  listSeats,
  inventory,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  SeatError,
} = await import('../server/seatService.js');

before(async () => {
  await initDb();
});

beforeEach(async () => {
  await resetSeats();
});

const TOTAL = 50;

async function counts() {
  const { counts } = await inventory();
  return counts;
}

test('seed creates a fixed seat map', async () => {
  const { seats } = await listSeats();
  assert.equal(seats.length, TOTAL);
  assert.ok(seats.every((s) => s.status === 'available'));
});

test('inventory always reconciles to total', async () => {
  const c = await counts();
  assert.equal(c.available + c.held + c.booked, c.total);
  assert.equal(c.total, TOTAL);
});

test('hold marks seats held and blocks others', async () => {
  const ids = [1, 2, 3];
  const { hold, seats } = await createHold(ids, 'alice');
  assert.equal(hold.seatIds.length, 3);
  assert.ok(seats.every((s) => s.status === 'held'));

  // Another user cannot hold an overlapping seat.
  await assert.rejects(
    () => createHold([3, 4], 'bob'),
    (err) => {
      assert.ok(err instanceof SeatError);
      assert.equal(err.status, 409);
      assert.deepEqual(err.extra.conflictSeatIds, [3]);
      return true;
    }
  );

  // Seat 4 should still be available (all-or-nothing).
  const { seats: after } = await listSeats();
  assert.equal(after.find((s) => s.id === 4).status, 'available');

  const c = await counts();
  assert.equal(c.held, 3);
});

test('all-or-nothing: a conflict acquires no seats', async () => {
  await createHold([5], 'alice');
  await assert.rejects(() => createHold([5, 6, 7], 'bob'), SeatError);
  const { seats } = await listSeats();
  // 6 and 7 must remain available.
  assert.equal(seats.find((s) => s.id === 6).status, 'available');
  assert.equal(seats.find((s) => s.id === 7).status, 'available');
});

test('confirm books the held seats', async () => {
  const { hold } = await createHold([10, 11], 'alice');
  const res = await confirmHold(hold.holdId, 'alice');
  assert.equal(res.idempotent, false);
  assert.deepEqual(res.booking.seatIds, [10, 11]);
  assert.ok(res.seats.every((s) => s.status === 'booked'));

  const c = await counts();
  assert.equal(c.booked, 2);
});

test('confirmation is idempotent', async () => {
  const { hold } = await createHold([20, 21], 'alice');
  const first = await confirmHold(hold.holdId, 'alice');
  const second = await confirmHold(hold.holdId, 'alice');
  assert.equal(second.idempotent, true);
  assert.equal(first.booking.bookingId, second.booking.bookingId);

  const c = await counts();
  assert.equal(c.booked, 2); // exactly once
});

test('confirming an unknown hold fails and books nothing', async () => {
  await assert.rejects(
    () => confirmHold('does-not-exist', 'alice'),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
  const c = await counts();
  assert.equal(c.booked, 0);
});

test('confirming an expired hold fails and books nothing', async () => {
  const { hold } = await createHold([30, 31], 'alice');
  await new Promise((r) => setTimeout(r, 500)); // > TTL
  await assert.rejects(
    () => confirmHold(hold.holdId, 'alice'),
    (err) => {
      assert.equal(err.status, 410);
      return true;
    }
  );
  const c = await counts();
  assert.equal(c.booked, 0);
  assert.equal(c.held, 0);
  assert.equal(c.available, TOTAL);
});

test('holds expire automatically and free their seats on read', async () => {
  await createHold([40, 41, 42], 'alice');
  let c = await counts();
  assert.equal(c.held, 3);

  await new Promise((r) => setTimeout(r, 500));

  const { seats } = await listSeats();
  assert.ok([40, 41, 42].every((id) => seats.find((s) => s.id === id).status === 'available'));

  c = await counts();
  assert.equal(c.held, 0);
  assert.equal(c.available, TOTAL);
});

test('expired seats can be re-held by another user', async () => {
  await createHold([45], 'alice');
  await new Promise((r) => setTimeout(r, 500));
  const { hold } = await createHold([45], 'bob');
  assert.equal(hold.seatIds[0], 45);
});

test('release returns seats to available', async () => {
  const { hold } = await createHold([1, 2], 'alice');
  await releaseHold(hold.holdId, 'alice');
  const c = await counts();
  assert.equal(c.available, TOTAL);
  assert.equal(c.held, 0);
});

test('sweep releases stale holds', async () => {
  await createHold([3, 4], 'alice');
  await new Promise((r) => setTimeout(r, 500));
  const released = await sweepExpired();
  assert.equal(released.length, 2);
  const c = await counts();
  assert.equal(c.available, TOTAL);
});

test('CONCURRENCY: only one of many concurrent holds for the same seat wins', async () => {
  const SEAT = 7;
  const attempts = 50;
  const results = await Promise.allSettled(
    Array.from({ length: attempts }, (_, i) => createHold([SEAT], `user-${i}`))
  );
  const wins = results.filter((r) => r.status === 'fulfilled');
  assert.equal(wins.length, 1, 'exactly one hold should win');

  const losers = results.filter((r) => r.status === 'rejected');
  assert.equal(losers.length, attempts - 1);
  assert.ok(losers.every((r) => r.reason instanceof SeatError && r.reason.status === 409));
});

test('CONCURRENCY: a seat is never booked by two different sessions', async () => {
  const SEAT = 9;
  // Many users race to hold then confirm the same seat.
  const results = await Promise.allSettled(
    Array.from({ length: 30 }, async (_, i) => {
      const { hold } = await createHold([SEAT], `user-${i}`);
      return confirmHold(hold.holdId, `user-${i}`);
    })
  );
  const confirmed = results.filter((r) => r.status === 'fulfilled');
  assert.equal(confirmed.length, 1, 'only one session books the seat');

  // Verify in the DB the seat is booked by exactly one session.
  const { rows } = await getDb().query('SELECT * FROM seats WHERE id=$1', [SEAT]);
  assert.equal(rows[0].status, 'booked');
});

test('CONCURRENCY: inventory stays exact under mixed concurrent ops', async () => {
  const ops = [];
  for (let i = 0; i < 40; i++) {
    const seat = 1 + (i % TOTAL);
    ops.push(
      (async () => {
        try {
          const { hold } = await createHold([seat], `u-${i}`);
          if (i % 2 === 0) await confirmHold(hold.holdId, `u-${i}`);
          else await releaseHold(hold.holdId, `u-${i}`);
        } catch {
          /* conflicts expected */
        }
      })()
    );
  }
  await Promise.all(ops);
  const c = await counts();
  assert.equal(c.available + c.held + c.booked, c.total);
  assert.equal(c.total, TOTAL);
});

test('non-owner cannot confirm or release another session hold', async () => {
  const { hold } = await createHold([12, 13], 'alice');
  await assert.rejects(() => confirmHold(hold.holdId, 'mallory'), (e) => e.status === 403);
  await assert.rejects(() => releaseHold(hold.holdId, 'mallory'), (e) => e.status === 403);
  // Alice can still confirm.
  const res = await confirmHold(hold.holdId, 'alice');
  assert.equal(res.booking.seatIds.length, 2);
});
