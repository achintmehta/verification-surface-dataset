// Tests for the core seat-booking logic and HTTP API.
//
// These exercise the acceptance criteria:
//  - atomic, all-or-nothing holds (no double-acquire under concurrency)
//  - active holds block others
//  - TTL expiry frees seats automatically
//  - confirming expired/unknown holds fails and books nothing
//  - idempotent confirmation
//  - inventory always reconciles (available + active-held + booked = total)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createDb } from '../server/db.js';
import {
  initSchema,
  getSeats,
  createHold,
  confirmHold,
  releaseHold,
  sweepExpired,
  getInventory,
  ConflictError,
  HoldError,
} from '../server/booking.js';
import { ROWS, SEATS_PER_ROW } from '../server/config.js';

const TOTAL = ROWS.length * SEATS_PER_ROW;

async function freshDb() {
  // In-memory PGLite for isolation. createDb(undefined) -> memory db.
  const db = await createDb();
  await initSchema(db);
  return db;
}

async function assertReconciles(db) {
  const inv = await getInventory(db);
  assert.equal(
    inv.available + inv.held + inv.booked,
    inv.total,
    'inventory must reconcile'
  );
  assert.equal(inv.total, TOTAL);
  return inv;
}

test('seeds a fixed seat map with all available seats', async () => {
  const db = await freshDb();
  const { seats } = await getSeats(db);
  assert.equal(seats.length, TOTAL);
  assert.ok(seats.every((s) => s.status === 'available'));
  await assertReconciles(db);
  await db.close();
});

test('createHold marks seats held and blocks others', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['A1', 'A2'], 'sess-1');
  assert.equal(hold.seatIds.length, 2);

  const { seats } = await getSeats(db);
  const a1 = seats.find((s) => s.id === 'A1');
  assert.equal(a1.status, 'held');

  // Another session cannot hold the same seat.
  await assert.rejects(
    () => createHold(db, ['A2', 'A3'], 'sess-2'),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.deepEqual(err.conflicts, ['A2']);
      return true;
    }
  );

  // All-or-nothing: A3 was NOT acquired by sess-2.
  const after = (await getSeats(db)).seats.find((s) => s.id === 'A3');
  assert.equal(after.status, 'available');
  await assertReconciles(db);
  await db.close();
});

test('hold is all-or-nothing across multiple conflicts', async () => {
  const db = await freshDb();
  await createHold(db, ['B1'], 'x');
  await createHold(db, ['B3'], 'y');

  await assert.rejects(
    () => createHold(db, ['B1', 'B2', 'B3', 'B4'], 'z'),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.deepEqual(err.conflicts, ['B1', 'B3']);
      return true;
    }
  );
  // B2 and B4 must remain available.
  const seats = (await getSeats(db)).seats;
  assert.equal(seats.find((s) => s.id === 'B2').status, 'available');
  assert.equal(seats.find((s) => s.id === 'B4').status, 'available');
  await db.close();
});

test('confirmHold books the seats permanently', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['C1', 'C2'], 'me');
  const { booking } = await confirmHold(db, hold.id);
  assert.equal(booking.status, 'confirmed');
  assert.deepEqual(booking.seatIds.sort(), ['C1', 'C2']);

  const seats = (await getSeats(db)).seats;
  assert.ok(['C1', 'C2'].every((id) => seats.find((s) => s.id === id).status === 'booked'));
  await assertReconciles(db);
  await db.close();
});

test('confirmation is idempotent (books exactly once)', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['D1', 'D2'], 'me');

  const first = await confirmHold(db, hold.id);
  const second = await confirmHold(db, hold.id);
  const third = await confirmHold(db, hold.id);

  assert.deepEqual(first.booking.seatIds.sort(), ['D1', 'D2']);
  assert.deepEqual(second.booking.seatIds.sort(), ['D1', 'D2']);
  assert.deepEqual(third.booking.seatIds.sort(), ['D1', 'D2']);

  const inv = await assertReconciles(db);
  assert.equal(inv.booked, 2);
  await db.close();
});

test('confirming an unknown hold fails and books nothing', async () => {
  const db = await freshDb();
  await assert.rejects(
    () => confirmHold(db, randomUUID()),
    (err) => err instanceof HoldError
  );
  const inv = await assertReconciles(db);
  assert.equal(inv.booked, 0);
  await db.close();
});

test('expired holds are released on read and seats become available', async () => {
  const db = await freshDb();
  const now = Date.now();
  // Create a hold "in the past" by manipulating the clock argument.
  const { hold } = await createHold(db, ['E1', 'E2'], 'late', now);

  // Far in the future, past the TTL: getSeats should report them available.
  const future = now + 999_999_999;
  const { seats, released } = await getSeats(db, future);
  assert.ok(['E1', 'E2'].every((id) => seats.find((s) => s.id === id).status === 'available'));
  assert.deepEqual([...released].sort(), ['E1', 'E2']);

  // Confirming the expired hold must now fail and book nothing.
  await assert.rejects(
    () => confirmHold(db, hold.id, future),
    (err) => err instanceof HoldError
  );
  const inv = await getInventory(db, future);
  assert.equal(inv.booked, 0);
  await db.close();
});

test('expired seats can be re-held by another session', async () => {
  const db = await freshDb();
  const now = Date.now();
  await createHold(db, ['A5'], 'first', now);

  const future = now + 999_999_999;
  // Second session holds the now-expired seat.
  const { hold } = await createHold(db, ['A5'], 'second', future);
  const seat = (await getSeats(db, future)).seats.find((s) => s.id === 'A5');
  assert.equal(seat.status, 'held');
  assert.equal(seat.holdId, hold.id);
  await db.close();
});

test('releaseHold returns seats to available', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['B7', 'B8'], 'sess');
  const { released } = await releaseHold(db, hold.id);
  assert.deepEqual(released.sort(), ['B7', 'B8']);

  const seats = (await getSeats(db)).seats;
  assert.ok(['B7', 'B8'].every((id) => seats.find((s) => s.id === id).status === 'available'));

  // Cannot confirm a released hold.
  await assert.rejects(
    () => confirmHold(db, hold.id),
    (err) => err instanceof HoldError
  );
  await db.close();
});

test('cannot release a confirmed hold', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['C7'], 'sess');
  await confirmHold(db, hold.id);
  await assert.rejects(
    () => releaseHold(db, hold.id),
    (err) => err instanceof HoldError
  );
  await db.close();
});

test('concurrent holds for the same seat: exactly one succeeds', async () => {
  const db = await freshDb();
  const N = 25;
  const attempts = [];
  for (let i = 0; i < N; i++) {
    attempts.push(
      createHold(db, ['A1'], `sess-${i}`).then(
        () => 'ok',
        (err) => (err instanceof ConflictError ? 'conflict' : Promise.reject(err))
      )
    );
  }
  const results = await Promise.all(attempts);
  const oks = results.filter((r) => r === 'ok').length;
  assert.equal(oks, 1, 'exactly one concurrent hold should win');

  const seat = (await getSeats(db)).seats.find((s) => s.id === 'A1');
  assert.equal(seat.status, 'held');
  await assertReconciles(db);
  await db.close();
});

test('concurrent holds across overlapping seat sets never double-acquire', async () => {
  const db = await freshDb();
  // Many sessions each try to grab a random pair of seats. No seat may end up
  // held by two distinct holds, and inventory must reconcile.
  const allSeats = (await getSeats(db)).seats.map((s) => s.id);
  const pick = () => allSeats[Math.floor(Math.random() * allSeats.length)];

  const attempts = [];
  for (let i = 0; i < 60; i++) {
    const a = pick();
    let b = pick();
    while (b === a) b = pick();
    attempts.push(
      createHold(db, [a, b], `c-${i}`).then(
        (r) => r,
        (err) => (err instanceof ConflictError ? null : Promise.reject(err))
      )
    );
  }
  const results = await Promise.all(attempts);

  // Verify no seat is held by two different holds.
  const seatToHold = new Map();
  for (const r of results) {
    if (!r) continue;
    for (const seatId of r.hold.seatIds) {
      assert.ok(!seatToHold.has(seatId), `seat ${seatId} acquired twice`);
      seatToHold.set(seatId, r.hold.id);
    }
  }
  await assertReconciles(db);
  await db.close();
});

test('concurrent confirms of the same hold book exactly once', async () => {
  const db = await freshDb();
  const { hold } = await createHold(db, ['D5', 'D6'], 'sess');

  const confirms = [];
  for (let i = 0; i < 10; i++) {
    confirms.push(confirmHold(db, hold.id));
  }
  const results = await Promise.all(confirms);
  for (const r of results) {
    assert.deepEqual(r.booking.seatIds.sort(), ['D5', 'D6']);
    assert.equal(r.booking.status, 'confirmed');
  }
  const inv = await assertReconciles(db);
  assert.equal(inv.booked, 2);
  await db.close();
});

test('sweepExpired releases stale holds', async () => {
  const db = await freshDb();
  const now = Date.now();
  await createHold(db, ['E9', 'E10'], 'sess', now);
  const released = await sweepExpired(db, now + 999_999_999);
  assert.deepEqual(released.sort(), ['E10', 'E9']);
  const inv = await getInventory(db, now + 999_999_999);
  assert.equal(inv.held, 0);
  assert.equal(inv.available, TOTAL);
  await db.close();
});

test('inventory reconciles after a mixed sequence', async () => {
  const db = await freshDb();
  const now = Date.now();

  const h1 = (await createHold(db, ['A1', 'A2'], 's1', now)).hold;
  await confirmHold(db, h1.id, now); // booked

  const h2 = (await createHold(db, ['A3', 'A4'], 's2', now)).hold;
  await releaseHold(db, h2.id, now); // released

  await createHold(db, ['A5'], 's3', now); // active, will expire
  await createHold(db, ['B1', 'B2'], 's4', now); // active, stays

  const later = now + 1000; // within TTL
  const inv = await getInventory(db, later);
  assert.equal(inv.booked, 2);
  assert.equal(inv.held, 3); // A5, B1, B2
  assert.equal(inv.available, TOTAL - 5);
  assert.equal(inv.available + inv.held + inv.booked, TOTAL);

  // After TTL, the active holds expire.
  const after = now + 999_999_999;
  const inv2 = await getInventory(db, after);
  assert.equal(inv2.booked, 2);
  assert.equal(inv2.held, 0);
  assert.equal(inv2.available, TOTAL - 2);
  await db.close();
});
