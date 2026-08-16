/**
 * Comprehensive test suite for the seat-booking backend.
 *
 * Tests cover:
 *  - Seat map initialization and GET /api/seats
 *  - Hold creation (happy path, all-or-nothing, unknown seats)
 *  - Hold confirmation (happy path, idempotency, expiry, wrong session)
 *  - Hold release (DELETE)
 *  - Automatic expiry (lazy + sweep)
 *  - Inventory invariant (available + held + booked === total)
 *  - Concurrency: two simultaneous requests for the same seat
 */

import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { initDb, HOLD_TTL_SECONDS } from '../src/db.js';
import { createRouter } from '../src/routes.js';
import { sweepExpiredHolds } from '../src/seats.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Create a fresh in-memory PGlite + Express app for each test. */
async function buildApp() {
  const db = new PGlite(); // in-memory
  await db.waitReady;
  await initDb(db);
  const app = express();
  app.use(express.json());
  app.use('/api', createRouter(db));
  return { app, db };
}

/** Return all seats from the API. */
async function getSeats(app) {
  const res = await request(app).get('/api/seats');
  expect(res.status).toBe(200);
  return res.body.seats;
}

/** Assert the inventory invariant. */
async function assertInventory(app, totalExpected) {
  const seats = await getSeats(app);
  const available = seats.filter((s) => s.status === 'available').length;
  const held = seats.filter((s) => s.status === 'held').length;
  const booked = seats.filter((s) => s.status === 'booked').length;
  expect(available + held + booked).toBe(totalExpected);
  return { available, held, booked, total: totalExpected };
}

/** Force a seat's hold_expires_at into the past so it appears expired. */
async function expireSeat(db, seatId) {
  await db.query(
    `UPDATE seats
     SET hold_expires_at = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [seatId]
  );
}

/** Force a hold's expires_at into the past. */
async function expireHold(db, holdId) {
  await db.query(
    `UPDATE holds
     SET expires_at = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [holdId]
  );
  // Also expire the seat-level timestamp
  await db.query(
    `UPDATE seats
     SET hold_expires_at = NOW() - INTERVAL '1 second'
     WHERE hold_id = $1`,
    [holdId]
  );
}

const TOTAL_SEATS = 50; // 5 rows × 10 seats

// ─── 1. Seat map ──────────────────────────────────────────────────────────────

describe('1. Seat map', () => {
  test('1.1 GET /api/seats returns all 50 seats', async () => {
    const { app } = await buildApp();
    const seats = await getSeats(app);
    expect(seats).toHaveLength(TOTAL_SEATS);
  });

  test('1.2 All seats start as available', async () => {
    const { app } = await buildApp();
    const seats = await getSeats(app);
    expect(seats.every((s) => s.status === 'available')).toBe(true);
  });

  test('1.3 Seats are ordered by row then seat number', async () => {
    const { app } = await buildApp();
    const seats = await getSeats(app);
    const labels = seats.map((s) => `${s.row_label}${s.seat_number}`);
    expect(labels[0]).toBe('A1');
    expect(labels[9]).toBe('A10');
    expect(labels[10]).toBe('B1');
    expect(labels[49]).toBe('E10');
  });

  test('1.4 Inventory invariant holds on fresh DB', async () => {
    const { app } = await buildApp();
    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
  });
});

// ─── 2. Hold creation ─────────────────────────────────────────────────────────

describe('2. Hold creation', () => {
  test('2.1 POST /api/holds creates a hold and marks seats as held', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    expect(res.status).toBe(201);
    expect(res.body.hold).toBeDefined();
    expect(res.body.hold.id).toBeTruthy();
    expect(res.body.hold.seatIds).toEqual(expect.arrayContaining(['A1', 'A2']));
    expect(res.body.seats).toHaveLength(2);
    expect(res.body.seats.every((s) => s.status === 'held')).toBe(true);
  });

  test('2.2 Hold has a future expiresAt', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'session-1' });

    expect(res.status).toBe(201);
    const expiresAt = new Date(res.body.hold.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test('2.3 Held seats are no longer available', async () => {
    const { app } = await buildApp();
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    const a2 = seats.find((s) => s.id === 'A2');
    expect(a1.status).toBe('held');
    expect(a2.status).toBe('held');
  });

  test('2.4 All-or-nothing: if one seat is unavailable, none are held (409)', async () => {
    const { app } = await buildApp();
    // Hold A1 with session-1
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    // Try to hold A1 + A2 with session-2 — should fail entirely
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-2' });

    expect(res.status).toBe(409);
    expect(res.body.conflictingSeats).toContain('A1');

    // A2 must still be available
    const seats = await getSeats(app);
    const a2 = seats.find((s) => s.id === 'A2');
    expect(a2.status).toBe('available');
  });

  test('2.5 409 response lists all conflicting seats', async () => {
    const { app } = await buildApp();
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'session-2' });

    expect(res.status).toBe(409);
    expect(res.body.conflictingSeats).toEqual(
      expect.arrayContaining(['A1', 'A2'])
    );
  });

  test('2.6 Unknown seat IDs return 404', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['Z99'], sessionId: 'session-1' });

    expect(res.status).toBe(404);
  });

  test('2.7 Missing sessionId returns 400', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'] });

    expect(res.status).toBe(400);
  });

  test('2.8 Empty seatIds returns 400', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: [], sessionId: 'session-1' });

    expect(res.status).toBe(400);
  });

  test('2.9 Inventory invariant after hold', async () => {
    const { app } = await buildApp();
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'session-1' });

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.held).toBe(3);
    expect(inv.available).toBe(TOTAL_SEATS - 3);
  });
});

// ─── 3. Hold confirmation ─────────────────────────────────────────────────────

describe('3. Hold confirmation', () => {
  test('3.1 Confirming a valid hold books the seats', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    const confirmRes = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.bookedSeatIds).toEqual(
      expect.arrayContaining(['A1', 'A2'])
    );
  });

  test('3.2 Booked seats appear as booked in GET /api/seats', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'session-1' });

    await request(app)
      .post(`/api/holds/${holdRes.body.hold.id}/confirm`)
      .send({ sessionId: 'session-1' });

    const seats = await getSeats(app);
    const b1 = seats.find((s) => s.id === 'B1');
    expect(b1.status).toBe('booked');
  });

  test('3.3 Confirmation is idempotent (second confirm returns same result)', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;

    const first = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    const second = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.bookedSeatIds).toEqual(
      expect.arrayContaining(first.body.bookedSeatIds)
    );

    // Seat must still be booked exactly once
    const seats = await getSeats(app);
    const c1 = seats.find((s) => s.id === 'C1');
    expect(c1.status).toBe('booked');
  });

  test('3.4 Confirming an expired hold returns 410', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    await expireHold(db, holdId);

    const confirmRes = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    expect(confirmRes.status).toBe(410);
  });

  test('3.5 Confirming an expired hold books nothing', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D2'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    await expireHold(db, holdId);

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    const seats = await getSeats(app);
    const d2 = seats.find((s) => s.id === 'D2');
    // After expiry, seat should be available (not booked)
    expect(d2.status).toBe('available');
  });

  test('3.6 Confirming an unknown hold returns 404', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/holds/nonexistent-hold-id/confirm')
      .send({ sessionId: 'session-1' });

    expect(res.status).toBe(404);
  });

  test('3.7 Confirming with wrong sessionId returns 403', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-WRONG' });

    expect(res.status).toBe(403);
  });

  test('3.8 Inventory invariant after confirm', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    await request(app)
      .post(`/api/holds/${holdRes.body.hold.id}/confirm`)
      .send({ sessionId: 'session-1' });

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.booked).toBe(2);
    expect(inv.held).toBe(0);
    expect(inv.available).toBe(TOTAL_SEATS - 2);
  });

  test('3.9 Booked seat cannot be held by another session', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    await request(app)
      .post(`/api/holds/${holdRes.body.hold.id}/confirm`)
      .send({ sessionId: 'session-1' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-2' });

    expect(res.status).toBe(409);
  });
});

// ─── 4. Hold release ──────────────────────────────────────────────────────────

describe('4. Hold release (DELETE)', () => {
  test('4.1 Releasing a hold returns seats to available', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    const delRes = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'session-1' });

    expect(delRes.status).toBe(200);

    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    const a2 = seats.find((s) => s.id === 'A2');
    expect(a1.status).toBe('available');
    expect(a2.status).toBe('available');
  });

  test('4.2 Released seats can be held by another session', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    await request(app)
      .delete(`/api/holds/${holdRes.body.hold.id}`)
      .send({ sessionId: 'session-1' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-2' });

    expect(res.status).toBe(201);
  });

  test('4.3 Releasing with wrong sessionId returns 403', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    const res = await request(app)
      .delete(`/api/holds/${holdRes.body.hold.id}`)
      .send({ sessionId: 'session-WRONG' });

    expect(res.status).toBe(403);
  });

  test('4.4 Releasing unknown hold returns 404', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .delete('/api/holds/nonexistent')
      .send({ sessionId: 'session-1' });

    expect(res.status).toBe(404);
  });

  test('4.5 Inventory invariant after release', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'session-1' });

    await request(app)
      .delete(`/api/holds/${holdRes.body.hold.id}`)
      .send({ sessionId: 'session-1' });

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
  });
});

// ─── 5. Automatic expiry ──────────────────────────────────────────────────────

describe('5. Automatic expiry', () => {
  test('5.1 Expired held seat is reported as available in GET /api/seats', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    await expireHold(db, holdRes.body.hold.id);

    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    expect(a1.status).toBe('available');
  });

  test('5.2 Expired seat can be held by another session', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });

    await expireHold(db, holdRes.body.hold.id);

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-2' });

    expect(res.status).toBe(201);
  });

  test('5.3 sweepExpiredHolds releases stale holds', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2'], sessionId: 'session-1' });

    await expireHold(db, holdRes.body.hold.id);
    await sweepExpiredHolds(db);

    const seats = await getSeats(app);
    const b1 = seats.find((s) => s.id === 'B1');
    const b2 = seats.find((s) => s.id === 'B2');
    expect(b1.status).toBe('available');
    expect(b2.status).toBe('available');
  });

  test('5.4 Inventory invariant after expiry', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2'], sessionId: 'session-1' });

    await expireHold(db, holdRes.body.hold.id);

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
  });

  test('5.5 Confirming after expiry does not book the seat', async () => {
    const { app, db } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;
    await expireHold(db, holdId);

    const confirmRes = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'session-1' });

    expect(confirmRes.status).toBe(410);

    const seats = await getSeats(app);
    const d1 = seats.find((s) => s.id === 'D1');
    expect(d1.status).toBe('available');
  });
});

// ─── 6. Concurrency ───────────────────────────────────────────────────────────

describe('6. Concurrency', () => {
  test('6.1 Two simultaneous hold requests for the same seat: exactly one succeeds', async () => {
    const { app } = await buildApp();

    const [res1, res2] = await Promise.all([
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: 'session-1' }),
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: 'session-2' }),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(409);

    // Exactly one hold
    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    expect(a1.status).toBe('held');
  });

  test('6.2 Many concurrent requests for the same seat: exactly one succeeds', async () => {
    const { app } = await buildApp();
    const N = 10;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post('/api/holds')
          .send({ seatIds: ['A1'], sessionId: `session-${i}` })
      )
    );

    const successes = results.filter((r) => r.status === 201);
    const failures = results.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(N - 1);

    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    expect(a1.status).toBe('held');
  });

  test('6.3 Concurrent holds for different seats all succeed', async () => {
    const { app } = await buildApp();

    const results = await Promise.all([
      request(app).post('/api/holds').send({ seatIds: ['A1'], sessionId: 's1' }),
      request(app).post('/api/holds').send({ seatIds: ['A2'], sessionId: 's2' }),
      request(app).post('/api/holds').send({ seatIds: ['A3'], sessionId: 's3' }),
      request(app).post('/api/holds').send({ seatIds: ['A4'], sessionId: 's4' }),
      request(app).post('/api/holds').send({ seatIds: ['A5'], sessionId: 's5' }),
    ]);

    expect(results.every((r) => r.status === 201)).toBe(true);

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.held).toBe(5);
  });

  test('6.4 Concurrent confirms of the same hold: seats booked exactly once', async () => {
    const { app } = await buildApp();
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'session-1' });

    const holdId = holdRes.body.hold.id;

    const [c1, c2, c3] = await Promise.all([
      request(app)
        .post(`/api/holds/${holdId}/confirm`)
        .send({ sessionId: 'session-1' }),
      request(app)
        .post(`/api/holds/${holdId}/confirm`)
        .send({ sessionId: 'session-1' }),
      request(app)
        .post(`/api/holds/${holdId}/confirm`)
        .send({ sessionId: 'session-1' }),
    ]);

    // All should succeed (idempotent)
    expect([c1.status, c2.status, c3.status].every((s) => s === 200)).toBe(true);

    // Seats booked exactly once
    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    const a2 = seats.find((s) => s.id === 'A2');
    expect(a1.status).toBe('booked');
    expect(a2.status).toBe('booked');

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.booked).toBe(2);
  });

  test('6.5 No seat is ever booked by two different sessions', async () => {
    const { app } = await buildApp();

    // Session 1 holds A1
    const hold1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-1' });
    expect(hold1.status).toBe(201);

    // Session 2 tries to hold A1 — must fail
    const hold2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-2' });
    expect(hold2.status).toBe(409);

    // Session 1 confirms
    await request(app)
      .post(`/api/holds/${hold1.body.hold.id}/confirm`)
      .send({ sessionId: 'session-1' });

    // Session 2 tries again — must still fail
    const hold3 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'session-2' });
    expect(hold3.status).toBe(409);

    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    expect(a1.status).toBe('booked');
    expect(a1.booked_by).toBe('session-1');
  });
});

// ─── 7. Full lifecycle ────────────────────────────────────────────────────────

describe('7. Full lifecycle', () => {
  test('7.1 Hold → confirm → inventory correct', async () => {
    const { app } = await buildApp();

    const h = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'B1', 'C1'], sessionId: 'user-1' });
    expect(h.status).toBe(201);

    const c = await request(app)
      .post(`/api/holds/${h.body.hold.id}/confirm`)
      .send({ sessionId: 'user-1' });
    expect(c.status).toBe(200);

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.booked).toBe(3);
    expect(inv.held).toBe(0);
    expect(inv.available).toBe(TOTAL_SEATS - 3);
  });

  test('7.2 Hold → release → re-hold by another user', async () => {
    const { app } = await buildApp();

    const h1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'user-1' });

    await request(app)
      .delete(`/api/holds/${h1.body.hold.id}`)
      .send({ sessionId: 'user-1' });

    const h2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'user-2' });

    expect(h2.status).toBe(201);
  });

  test('7.3 Mixed operations keep inventory balanced', async () => {
    const { app, db } = await buildApp();

    // User 1 holds A1-A3 and confirms
    const h1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'u1' });
    await request(app)
      .post(`/api/holds/${h1.body.hold.id}/confirm`)
      .send({ sessionId: 'u1' });

    // User 2 holds B1-B2 and releases
    const h2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2'], sessionId: 'u2' });
    await request(app)
      .delete(`/api/holds/${h2.body.hold.id}`)
      .send({ sessionId: 'u2' });

    // User 3 holds C1 and lets it expire
    const h3 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'u3' });
    await expireHold(db, h3.body.hold.id);

    // User 4 holds D1-D2 (still active)
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1', 'D2'], sessionId: 'u4' });

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.booked).toBe(3);   // A1, A2, A3
    expect(inv.held).toBe(2);     // D1, D2
    expect(inv.available).toBe(TOTAL_SEATS - 5);
  });

  test('7.4 Confirming expired hold after another user holds the seat does not double-book', async () => {
    const { app, db } = await buildApp();

    // User 1 holds A1
    const h1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'u1' });
    const holdId1 = h1.body.hold.id;

    // Expire user 1's hold
    await expireHold(db, holdId1);

    // User 2 holds A1 (now available)
    const h2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'u2' });
    expect(h2.status).toBe(201);

    // User 1 tries to confirm their expired hold — must fail
    const confirmRes = await request(app)
      .post(`/api/holds/${holdId1}/confirm`)
      .send({ sessionId: 'u1' });
    expect(confirmRes.status).toBe(410);

    // A1 must still be held by user 2 (not booked by user 1)
    const seats = await getSeats(app);
    const a1 = seats.find((s) => s.id === 'A1');
    expect(a1.status).toBe('held');
    expect(a1.hold_id).toBe(h2.body.hold.id);

    const inv = await assertInventory(app, TOTAL_SEATS);
    expect(inv.booked).toBe(0);
  });
});
