import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initDb } from '../server/db.js';
import { BookingService, BookingError, summarise } from '../server/booking.js';
import { ROWS, SEATS_PER_ROW } from '../server/config.js';

const TOTAL = ROWS.length * SEATS_PER_ROW;

async function freshService(ttlMs = 60000) {
  const db = await initDb('memory://');
  return new BookingService(db, { ttlMs });
}

async function inventory(service) {
  const { summary } = await service.getSeats();
  return summary;
}

test('seed produces the fixed seat map, all available', async () => {
  const service = await freshService();
  const { seats, summary } = await service.getSeats();
  assert.equal(seats.length, TOTAL);
  assert.equal(summary.available, TOTAL);
  assert.equal(summary.held, 0);
  assert.equal(summary.booked, 0);
});

test('createHold acquires all requested seats and marks them held', async () => {
  const service = await freshService();
  const { hold, seats } = await service.createHold(['A1', 'A2', 'A3'], 'sess-1');
  assert.equal(hold.status, 'active');
  assert.equal(seats.length, 3);
  for (const s of seats) assert.equal(s.status, 'held');

  const inv = await inventory(service);
  assert.equal(inv.held, 3);
  assert.equal(inv.available, TOTAL - 3);
});

test('hold blocks others from holding the same seat (409 with conflicts)', async () => {
  const service = await freshService();
  await service.createHold(['B1', 'B2'], 'sess-1');
  await assert.rejects(
    () => service.createHold(['B2', 'B3'], 'sess-2'),
    (err) => {
      assert.ok(err instanceof BookingError);
      assert.equal(err.status, 409);
      assert.deepEqual(err.detail.conflictingSeatIds, ['B2']);
      return true;
    }
  );
  // All-or-nothing: B3 must NOT have been acquired.
  const { seats } = await service.getSeats();
  const b3 = seats.find((s) => s.id === 'B3');
  assert.equal(b3.status, 'available');
});

test('CONCURRENCY: many requests for the same seat -> exactly one wins', async () => {
  const service = await freshService();
  const N = 50;
  const seatId = 'C5';
  const attempts = [];
  for (let i = 0; i < N; i++) {
    attempts.push(
      service
        .createHold([seatId], `sess-${i}`)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, status: err.status }))
    );
  }
  const results = await Promise.all(attempts);
  const winners = results.filter((r) => r.ok);
  const losers = results.filter((r) => !r.ok);
  assert.equal(winners.length, 1, 'exactly one hold should win');
  assert.equal(losers.length, N - 1);
  for (const l of losers) assert.equal(l.status, 409);

  const { seats } = await service.getSeats();
  const seat = seats.find((s) => s.id === seatId);
  assert.equal(seat.status, 'held');
});

test('CONCURRENCY: overlapping multi-seat requests stay all-or-nothing & exact', async () => {
  const service = await freshService();
  // Many requests each asking for an overlapping window of seats in row D.
  const requests = [];
  for (let i = 1; i <= SEATS_PER_ROW - 2; i++) {
    const seatIds = [`D${i}`, `D${i + 1}`, `D${i + 2}`];
    requests.push(
      service
        .createHold(seatIds, `sess-${i}`)
        .then(() => ({ ok: true, seatIds }))
        .catch(() => ({ ok: false }))
    );
  }
  const results = await Promise.all(requests);
  const winners = results.filter((r) => r.ok);

  // No seat appears in two winning holds.
  const held = new Set();
  for (const w of winners) {
    for (const id of w.seatIds) {
      assert.ok(!held.has(id), `${id} held twice`);
      held.add(id);
    }
  }

  // Inventory must reconcile exactly.
  const inv = await inventory(service);
  assert.equal(inv.available + inv.held + inv.booked, TOTAL);
});

test('confirm books the held seats permanently', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['E1', 'E2'], 'sess-1');
  const result = await service.confirmHold(hold.id, 'sess-1');
  assert.equal(result.alreadyConfirmed, false);
  assert.equal(result.seats.length, 2);
  for (const s of result.seats) {
    assert.equal(s.status, 'booked');
    assert.equal(s.booked_by, 'sess-1');
  }
  const inv = await inventory(service);
  assert.equal(inv.booked, 2);
});

test('confirmation is idempotent: repeated confirms book exactly once', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['A5', 'A6'], 'sess-1');
  const first = await service.confirmHold(hold.id, 'sess-1');
  const second = await service.confirmHold(hold.id, 'sess-1');
  const third = await service.confirmHold(hold.id, 'sess-1');

  assert.equal(first.alreadyConfirmed, false);
  assert.equal(second.alreadyConfirmed, true);
  assert.equal(third.alreadyConfirmed, true);
  assert.equal(second.changed.length, 0, 'idempotent confirm changes nothing');

  const inv = await inventory(service);
  assert.equal(inv.booked, 2, 'still exactly 2 booked');
});

test('CONCURRENCY: many confirms of the same hold book exactly once', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['A8', 'A9'], 'sess-1');
  const attempts = [];
  for (let i = 0; i < 25; i++) attempts.push(service.confirmHold(hold.id, 'sess-1'));
  await Promise.all(attempts);
  const inv = await inventory(service);
  assert.equal(inv.booked, 2);
});

test('confirming an expired hold fails and books nothing', async () => {
  const service = await freshService(20); // 20ms TTL
  const { hold } = await service.createHold(['B5', 'B6'], 'sess-1');
  await new Promise((r) => setTimeout(r, 40));
  await assert.rejects(
    () => service.confirmHold(hold.id, 'sess-1'),
    (err) => {
      assert.equal(err.status, 409);
      return true;
    }
  );
  const inv = await inventory(service);
  assert.equal(inv.booked, 0);
  assert.equal(inv.available, TOTAL);
});

test('confirming an unknown hold fails', async () => {
  const service = await freshService();
  await assert.rejects(
    () => service.confirmHold('does-not-exist'),
    (err) => {
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('expired hold frees seats automatically on read (no manual action)', async () => {
  const service = await freshService(20);
  await service.createHold(['C1', 'C2', 'C3'], 'sess-1');
  let inv = await inventory(service);
  assert.equal(inv.held, 3);

  await new Promise((r) => setTimeout(r, 40));
  inv = await inventory(service); // read triggers expiry
  assert.equal(inv.held, 0);
  assert.equal(inv.available, TOTAL);
});

test('expired seats can be re-held by another user', async () => {
  const service = await freshService(20);
  await service.createHold(['C7'], 'sess-1');
  await new Promise((r) => setTimeout(r, 40));
  // sess-2 should now be able to acquire it.
  const { seats } = await service.createHold(['C7'], 'sess-2');
  assert.equal(seats[0].status, 'held');
});

test('releaseHold returns seats to available', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['D1', 'D2'], 'sess-1');
  const result = await service.releaseHold(hold.id, 'sess-1');
  assert.equal(result.seats.length, 2);
  for (const s of result.seats) assert.equal(s.status, 'available');
  const inv = await inventory(service);
  assert.equal(inv.available, TOTAL);
});

test('released seats can be re-acquired', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['D5'], 'sess-1');
  await service.releaseHold(hold.id, 'sess-1');
  const { seats } = await service.createHold(['D5'], 'sess-2');
  assert.equal(seats[0].status, 'held');
});

test('confirmed holds cannot be released', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['E5'], 'sess-1');
  await service.confirmHold(hold.id, 'sess-1');
  await assert.rejects(
    () => service.releaseHold(hold.id, 'sess-1'),
    (err) => {
      assert.equal(err.status, 409);
      return true;
    }
  );
});

test('cannot confirm a hold owned by another session', async () => {
  const service = await freshService();
  const { hold } = await service.createHold(['E7'], 'sess-1');
  await assert.rejects(
    () => service.confirmHold(hold.id, 'other'),
    (err) => {
      assert.equal(err.status, 403);
      return true;
    }
  );
});

test('sweepExpired releases stale holds in the background', async () => {
  const service = await freshService(20);
  await service.createHold(['A10', 'B10'], 'sess-1');
  await new Promise((r) => setTimeout(r, 40));
  const released = await service.sweepExpired();
  assert.equal(released.length, 2);
  for (const s of released) assert.equal(s.status, 'available');
});

test('INVARIANT: inventory always reconciles after a mixed workload', async () => {
  const service = await freshService(30);
  const ops = [];

  // Holds across the map by various sessions.
  for (let r = 0; r < ROWS.length; r++) {
    const row = ROWS[r];
    for (let n = 1; n <= SEATS_PER_ROW; n += 2) {
      ops.push(
        service
          .createHold([`${row}${n}`], `sess-${r}-${n}`)
          .then((res) => {
            // Randomly confirm or release some holds.
            const die = (r + n) % 3;
            if (die === 0) return service.confirmHold(res.hold.id, `sess-${r}-${n}`).catch(() => {});
            if (die === 1) return service.releaseHold(res.hold.id, `sess-${r}-${n}`).catch(() => {});
            return undefined; // leave it to expire
          })
          .catch(() => {})
      );
    }
  }
  await Promise.all(ops);

  // Let remaining holds expire and sweep.
  await new Promise((r) => setTimeout(r, 60));
  await service.sweepExpired();

  const { seats, summary } = await service.getSeats();
  assert.equal(summary.available + summary.held + summary.booked, TOTAL);
  // No seat is booked by two sessions is structurally impossible (one booked_by
  // per seat), but verify no held seats remain past expiry.
  assert.equal(summary.held, 0);

  // Every booked seat has a booked_by.
  for (const s of seats) {
    if (s.status === 'booked') assert.ok(s.booked_by, `booked seat ${s.id} missing booked_by`);
  }
});

test('summarise helper counts correctly', () => {
  const seats = [
    { status: 'available' },
    { status: 'held' },
    { status: 'held' },
    { status: 'booked' },
  ];
  assert.deepEqual(summarise(seats), { total: 4, available: 1, held: 2, booked: 1 });
});
