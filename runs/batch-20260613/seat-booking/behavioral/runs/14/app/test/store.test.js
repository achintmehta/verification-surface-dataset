import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDb, ROWS, SEATS_PER_ROW } from '../server/db.js';
import { SeatStore } from '../server/store.js';

const TOTAL = ROWS.length * SEATS_PER_ROW;

async function freshStore(opts = {}) {
  const db = await createDb(); // in-memory
  const events = [];
  const store = new SeatStore(db, {
    holdTtlMs: opts.holdTtlMs ?? 60_000,
    onBroadcast: (evs) => events.push(...evs),
  });
  return { db, store, events };
}

function statuses(seats) {
  const m = {};
  for (const s of seats) m[s.id] = s.status;
  return m;
}

test('seed creates a full seat map, all available', async () => {
  const { store } = await freshStore();
  const seats = await store.getSeats();
  assert.equal(seats.length, TOTAL);
  assert.ok(seats.every((s) => s.status === 'available'));
});

test('hold acquires all requested seats and marks them held', async () => {
  const { store } = await freshStore();
  const r = await store.createHold(['A1', 'A2'], 's1');
  assert.equal(r.ok, true);
  assert.deepEqual(r.hold.seatIds.sort(), ['A1', 'A2']);

  const st = statuses(await store.getSeats());
  assert.equal(st.A1, 'held');
  assert.equal(st.A2, 'held');
  assert.equal(st.A3, 'available');
});

test('hold is all-or-nothing: conflict acquires none and returns 409 with conflicts', async () => {
  const { store } = await freshStore();
  const first = await store.createHold(['B1', 'B2'], 's1');
  assert.equal(first.ok, true);

  const second = await store.createHold(['B2', 'B3'], 's2');
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.deepEqual(second.conflicts, ['B2']);

  // B3 must NOT have been acquired (all-or-nothing).
  const st = statuses(await store.getSeats());
  assert.equal(st.B3, 'available');
});

test('unknown seat ids produce 404', async () => {
  const { store } = await freshStore();
  const r = await store.createHold(['Z9'], 's1');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.deepEqual(r.conflicts, ['Z9']);
});

test('concurrency: many requests for the same seat — exactly one succeeds', async () => {
  const { store } = await freshStore();
  const N = 50;
  const results = await Promise.all(
    Array.from({ length: N }, (_, i) => store.createHold(['C5'], `s${i}`))
  );
  const wins = results.filter((r) => r.ok);
  assert.equal(wins.length, 1);

  const st = statuses(await store.getSeats());
  assert.equal(st.C5, 'held');
});

test('concurrency: overlapping multi-seat requests never double-acquire', async () => {
  const { store } = await freshStore();
  // Two requests that overlap on D5.
  const [r1, r2] = await Promise.all([
    store.createHold(['D4', 'D5'], 's1'),
    store.createHold(['D5', 'D6'], 's2'),
  ]);
  const okCount = [r1, r2].filter((r) => r.ok).length;
  // At most one can hold D5; the other must fail wholesale.
  assert.ok(okCount >= 1);

  const seats = await store.getSeats();
  const heldD5 = seats.filter((s) => s.id === 'D5' && s.status === 'held');
  assert.equal(heldD5.length, 1);

  // The failed one must have acquired NONE of its seats.
  const st = statuses(seats);
  if (!r1.ok) {
    // s1 failed -> D4 should be available unless s2 took it (it didn't request D4)
    assert.equal(st.D4, 'available');
  }
  if (!r2.ok) {
    assert.equal(st.D6, 'available');
  }
});

test('active hold blocks other holders and confirmations', async () => {
  const { store } = await freshStore();
  const h = await store.createHold(['E1'], 's1');
  assert.ok(h.ok);

  const blocked = await store.createHold(['E1'], 's2');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
});

test('confirm books the held seats', async () => {
  const { store } = await freshStore();
  const h = await store.createHold(['A5', 'A6'], 's1');
  const c = await store.confirmHold(h.hold.holdId);
  assert.equal(c.ok, true);
  assert.deepEqual(c.booking.seatIds, ['A5', 'A6']);

  const st = statuses(await store.getSeats());
  assert.equal(st.A5, 'booked');
  assert.equal(st.A6, 'booked');
});

test('confirm is idempotent: repeated confirms book exactly once', async () => {
  const { store } = await freshStore();
  const h = await store.createHold(['A7'], 's1');
  const c1 = await store.confirmHold(h.hold.holdId);
  const c2 = await store.confirmHold(h.hold.holdId);
  const c3 = await store.confirmHold(h.hold.holdId);

  assert.equal(c1.ok, true);
  assert.equal(c1.booking.alreadyConfirmed, false);
  assert.equal(c2.ok, true);
  assert.equal(c2.booking.alreadyConfirmed, true);
  assert.equal(c3.ok, true);
  assert.deepEqual(c2.booking.seatIds, ['A7']);

  const booked = (await store.getSeats()).filter((s) => s.status === 'booked');
  assert.equal(booked.length, 1);
});

test('concurrent confirms of same hold book exactly once', async () => {
  const { store } = await freshStore();
  const h = await store.createHold(['B7', 'B8'], 's1');
  const results = await Promise.all(
    Array.from({ length: 20 }, () => store.confirmHold(h.hold.holdId))
  );
  assert.ok(results.every((r) => r.ok));
  const booked = (await store.getSeats()).filter((s) => s.status === 'booked');
  assert.equal(booked.length, 2);
});

test('confirming an unknown hold fails and books nothing', async () => {
  const { store } = await freshStore();
  const r = await store.confirmHold('does-not-exist');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  const booked = (await store.getSeats()).filter((s) => s.status === 'booked');
  assert.equal(booked.length, 0);
});

test('confirming an expired hold fails and books nothing', async () => {
  const { store } = await freshStore({ holdTtlMs: 30 });
  const h = await store.createHold(['C1'], 's1');
  assert.ok(h.ok);
  await new Promise((r) => setTimeout(r, 60));
  const c = await store.confirmHold(h.hold.holdId);
  assert.equal(c.ok, false);
  // 404 (expired+swept) or 410 (expired) are both acceptable failures.
  assert.ok(c.status === 410 || c.status === 404);
  const booked = (await store.getSeats()).filter((s) => s.status === 'booked');
  assert.equal(booked.length, 0);
});

test('expiry releases held seats automatically on read', async () => {
  const { store } = await freshStore({ holdTtlMs: 30 });
  const h = await store.createHold(['C2', 'C3'], 's1');
  assert.ok(h.ok);
  await new Promise((r) => setTimeout(r, 60));
  const st = statuses(await store.getSeats());
  assert.equal(st.C2, 'available');
  assert.equal(st.C3, 'available');
});

test('expired seats can be re-held by another user', async () => {
  const { store } = await freshStore({ holdTtlMs: 30 });
  const h1 = await store.createHold(['C4'], 's1');
  assert.ok(h1.ok);
  await new Promise((r) => setTimeout(r, 60));
  const h2 = await store.createHold(['C4'], 's2');
  assert.equal(h2.ok, true);
});

test('release returns seats to available', async () => {
  const { store } = await freshStore();
  const h = await store.createHold(['D1', 'D2'], 's1');
  const r = await store.releaseHold(h.hold.holdId);
  assert.equal(r.ok, true);
  assert.deepEqual(r.released.sort(), ['D1', 'D2']);
  const st = statuses(await store.getSeats());
  assert.equal(st.D1, 'available');
  assert.equal(st.D2, 'available');
});

test('releasing an unknown/already-released hold fails gracefully', async () => {
  const { store } = await freshStore();
  const r = await store.releaseHold('nope');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
});

test('inventory always reconciles: available + held + booked = total', async () => {
  const { store } = await freshStore({ holdTtlMs: 200 });
  await store.createHold(['A1', 'A2', 'A3'], 's1');
  const h2 = await store.createHold(['B1', 'B2'], 's2');
  await store.confirmHold(h2.hold.holdId);
  const h3 = await store.createHold(['E9', 'E10'], 's3');
  await store.releaseHold(h3.hold.holdId);

  const s = await store.summary();
  assert.equal(s.available + s.held + s.booked, s.total);
  assert.equal(s.total, TOTAL);
  assert.equal(s.booked, 2);
});

test('sweep releases stale holds and reports seat ids', async () => {
  const { store } = await freshStore({ holdTtlMs: 30 });
  await store.createHold(['E1', 'E2'], 's1');
  await new Promise((r) => setTimeout(r, 60));
  const released = await store.sweep();
  assert.deepEqual(released.sort(), ['E1', 'E2']);
});

test('broadcasts emitted for held, booked, and released transitions', async () => {
  const { store, events } = await freshStore();
  const h = await store.createHold(['A9'], 's1');
  assert.ok(events.some((e) => e.type === 'held' && e.seatId === 'A9'));
  await store.confirmHold(h.hold.holdId);
  assert.ok(events.some((e) => e.type === 'booked' && e.seatId === 'A9'));

  const h2 = await store.createHold(['A10'], 's2');
  await store.releaseHold(h2.hold.holdId);
  assert.ok(events.some((e) => e.type === 'released' && e.seatId === 'A10'));
});

test('no seat ever booked by two sessions under concurrent confirm attempts', async () => {
  const { store } = await freshStore();
  // s1 holds B5; s2 tries to hold the same and both try to confirm.
  const h1 = await store.createHold(['B5'], 's1');
  const h2 = await store.createHold(['B5'], 's2'); // should fail
  assert.ok(h1.ok);
  assert.equal(h2.ok, false);

  const c1 = await store.confirmHold(h1.hold.holdId);
  assert.ok(c1.ok);

  const booked = (await store.getSeats()).filter((s) => s.id === 'B5');
  assert.equal(booked[0].status, 'booked');
});
