import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { createDb } from '../server/db.js';
import { BookingService } from '../server/booking.js';
import { ROWS, SEATS_PER_ROW, HOLD_TTL_MS } from '../server/config.js';

const TOTAL = ROWS.length * SEATS_PER_ROW;

/** Build a fresh in-memory service with a controllable clock. */
async function makeService() {
  const db = await createDb('memory://');
  let clock = Date.now();
  const changes = [];
  const service = new BookingService(
    db,
    (cs) => changes.push(...cs),
    () => clock,
  );
  return {
    service,
    changes,
    setNow: (ms) => {
      clock = ms;
    },
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}

async function inventory(service) {
  return service.getInventory();
}

test('seeds a fixed seat map of all available seats', async () => {
  const { service } = await makeService();
  const seats = await service.getSeats();
  assert.equal(seats.length, TOTAL);
  assert.ok(seats.every((s) => s.status === 'available'));
  const inv = await inventory(service);
  assert.deepEqual(inv, { available: TOTAL, held: 0, booked: 0, total: TOTAL });
});

test('hold acquires all requested seats atomically', async () => {
  const { service } = await makeService();
  const res = await service.hold(['A1', 'A2', 'A3'], 'sess-1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.hold.seatIds.sort(), ['A1', 'A2', 'A3']);

  const inv = await inventory(service);
  assert.equal(inv.held, 3);
  assert.equal(inv.available, TOTAL - 3);
  assert.equal(inv.booked, 0);
});

test('held seats block another session from holding them', async () => {
  const { service } = await makeService();
  await service.hold(['B1', 'B2'], 'sess-1');
  const res = await service.hold(['B2', 'B3'], 'sess-2');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.deepEqual(res.conflicts, ['B2']);

  // All-or-nothing: B3 must NOT have been acquired.
  const seats = await service.getSeats();
  const b3 = seats.find((s) => s.id === 'B3');
  assert.equal(b3.status, 'available');
});

test('concurrent holds for the same seat: exactly one wins', async () => {
  const { service } = await makeService();
  const N = 25;
  const seatId = 'C5';
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => service.hold([seatId], `sess-${i}`)),
  );
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, 'exactly one hold should succeed');
  assert.equal(results.filter((r) => !r.ok && r.status === 409).length, N - 1);

  const inv = await inventory(service);
  assert.equal(inv.held, 1);
  assert.equal(inv.available, TOTAL - 1);
});

test('concurrent overlapping multi-seat holds never double-acquire', async () => {
  const { service } = await makeService();
  // Three requests overlap on D5.
  const reqs = [
    service.hold(['D1', 'D2', 'D5'], 's1'),
    service.hold(['D5', 'D6', 'D7'], 's2'),
    service.hold(['D5', 'D8'], 's3'),
  ];
  const results = await Promise.all(reqs);
  const winners = results.filter((r) => r.ok);
  // Only one request that includes D5 can succeed for D5; but non-overlapping
  // requests could also win. Validate consistency rather than a fixed count.
  const heldSeats = new Set();
  for (const w of winners) {
    for (const id of w.hold.seatIds) {
      assert.ok(!heldSeats.has(id), `seat ${id} acquired twice`);
      heldSeats.add(id);
    }
  }
  const inv = await inventory(service);
  assert.equal(inv.held, heldSeats.size);
});

test('confirm books seats and is idempotent', async () => {
  const { service } = await makeService();
  const hold = await service.hold(['E1', 'E2'], 'sess-1');
  const first = await service.confirm(hold.hold.id);
  assert.equal(first.ok, true);
  assert.deepEqual(first.booking.seatIds.sort(), ['E1', 'E2']);

  const invAfter = await inventory(service);
  assert.equal(invAfter.booked, 2);

  // Confirm again — same booking, no extra seats booked.
  const second = await service.confirm(hold.hold.id);
  assert.equal(second.ok, true);
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.booking.seatIds.sort(), ['E1', 'E2']);

  const invAfter2 = await inventory(service);
  assert.equal(invAfter2.booked, 2, 'no additional booking on repeat confirm');
});

test('booked seats cannot be held by anyone', async () => {
  const { service } = await makeService();
  const hold = await service.hold(['A5'], 'sess-1');
  await service.confirm(hold.hold.id);
  const res = await service.hold(['A5'], 'sess-2');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
  assert.deepEqual(res.conflicts, ['A5']);
});

test('a seat is never booked by two different sessions under contention', async () => {
  const { service } = await makeService();
  const seatId = 'B7';
  // Many sessions race to hold then confirm the same seat.
  const attempts = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const h = await service.hold([seatId], `sess-${i}`);
      if (!h.ok) return null;
      const c = await service.confirm(h.hold.id);
      return c.ok ? c.booking.sessionId : null;
    }),
  );
  const bookers = new Set(attempts.filter(Boolean));
  assert.equal(bookers.size, 1, 'only one session can book the seat');

  const seats = await service.getSeats();
  const seat = seats.find((s) => s.id === seatId);
  assert.equal(seat.status, 'booked');
});

test('hold expires after TTL and seats become available without manual action', async () => {
  const ctx = await makeService();
  const { service } = ctx;
  await service.hold(['C1', 'C2'], 'sess-1');
  let inv = await inventory(service);
  assert.equal(inv.held, 2);

  // Advance past TTL; reading seats triggers lazy expiry.
  ctx.advance(HOLD_TTL_MS + 1);
  const seats = await service.getSeats();
  assert.ok(seats.find((s) => s.id === 'C1').status === 'available');
  assert.ok(seats.find((s) => s.id === 'C2').status === 'available');

  inv = await inventory(service);
  assert.equal(inv.held, 0);
  assert.equal(inv.available, TOTAL);
});

test('confirming an expired hold fails and books nothing', async () => {
  const ctx = await makeService();
  const { service } = ctx;
  const hold = await service.hold(['D1'], 'sess-1');
  ctx.advance(HOLD_TTL_MS + 1);

  const res = await service.confirm(hold.hold.id);
  assert.equal(res.ok, false);
  assert.equal(res.status, 410);

  const inv = await inventory(service);
  assert.equal(inv.booked, 0);
  assert.equal(inv.available, TOTAL);
});

test('confirming an unknown hold fails', async () => {
  const { service } = await makeService();
  const res = await service.confirm('does-not-exist');
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
});

test('expired seat can be re-held by another session', async () => {
  const ctx = await makeService();
  const { service } = ctx;
  await service.hold(['E5'], 'sess-1');
  ctx.advance(HOLD_TTL_MS + 1);
  const res = await service.hold(['E5'], 'sess-2');
  assert.equal(res.ok, true);
  assert.deepEqual(res.hold.seatIds, ['E5']);
});

test('release returns held seats to available', async () => {
  const { service } = await makeService();
  const hold = await service.hold(['A8', 'A9'], 'sess-1');
  const res = await service.release(hold.hold.id, 'sess-1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.released.sort(), ['A8', 'A9']);

  const inv = await inventory(service);
  assert.equal(inv.available, TOTAL);
  assert.equal(inv.held, 0);
});

test('release rejects mismatched session', async () => {
  const { service } = await makeService();
  const hold = await service.hold(['B9'], 'sess-1');
  const res = await service.release(hold.hold.id, 'sess-2');
  assert.equal(res.ok, false);
  assert.equal(res.status, 403);

  // Seat still held by original session.
  const seats = await service.getSeats();
  assert.equal(seats.find((s) => s.id === 'B9').status, 'held');
});

test('cannot release an already-confirmed hold', async () => {
  const { service } = await makeService();
  const hold = await service.hold(['C9'], 'sess-1');
  await service.confirm(hold.hold.id);
  const res = await service.release(hold.hold.id, 'sess-1');
  assert.equal(res.ok, false);
  assert.equal(res.status, 409);
});

test('inventory always reconciles: available + held + booked == total', async () => {
  const ctx = await makeService();
  const { service } = ctx;

  const h1 = await service.hold(['A1', 'A2', 'A3'], 's1');
  await service.confirm(h1.hold.id); // 3 booked
  await service.hold(['B1', 'B2'], 's2'); // 2 held
  const h3 = await service.hold(['C1'], 's3');
  await service.release(h3.hold.id, 's3'); // released back
  const h4 = await service.hold(['D1', 'D2'], 's4'); // held then expire
  ctx.advance(HOLD_TTL_MS + 1);
  await service.getSeats(); // trigger expiry

  // h4 expired, but s2's hold should also have expired now. Re-check.
  const inv = await inventory(service);
  assert.equal(inv.available + inv.held + inv.booked, TOTAL);
  assert.equal(inv.total, TOTAL);
  assert.equal(inv.booked, 3);
  void h4;
});

test('sweep releases stale holds and emits release changes', async () => {
  const ctx = await makeService();
  const { service, changes } = ctx;
  await service.hold(['E9', 'E10'], 's1');
  changes.length = 0;
  ctx.advance(HOLD_TTL_MS + 1);
  const released = await service.sweep();
  assert.equal(released.length, 2);
  assert.ok(changes.some((c) => c.seatId === 'E9' && c.status === 'available'));
});

test('change events are emitted for held -> booked transitions', async () => {
  const ctx = await makeService();
  const { service, changes } = ctx;
  const h = await service.hold(['A10'], 's1');
  assert.ok(changes.some((c) => c.seatId === 'A10' && c.status === 'held'));
  changes.length = 0;
  await service.confirm(h.hold.id);
  assert.ok(changes.some((c) => c.seatId === 'A10' && c.status === 'booked'));
});

test('empty or invalid hold input is rejected', async () => {
  const { service } = await makeService();
  assert.equal((await service.hold([], 's1')).status, 400);
  assert.equal((await service.hold(['A1'], '')).status, 400);
  const unknown = await service.hold(['Z99'], 's1');
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.conflicts, ['Z99']);
});

test('duplicate seat ids in one hold are de-duplicated', async () => {
  const { service } = await makeService();
  const res = await service.hold(['A1', 'A1', 'A2'], 's1');
  assert.equal(res.ok, true);
  assert.deepEqual(res.hold.seatIds.sort(), ['A1', 'A2']);
  const inv = await inventory(service);
  assert.equal(inv.held, 2);
});
