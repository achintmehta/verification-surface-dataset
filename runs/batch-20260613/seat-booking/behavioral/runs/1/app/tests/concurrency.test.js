/**
 * Concurrency tests.
 *
 * These tests fire multiple simultaneous requests for the same seat(s) and
 * verify that exactly one succeeds while the others receive 409.
 *
 * PGLite serializes transactions, so the "concurrency" here is at the HTTP
 * request level – multiple requests queued against the same in-process DB.
 */

import { buildApp, request } from './helpers.js';
import { ROWS, SEATS_PER_ROW } from '../server/src/db.js';

const TOTAL_SEATS = ROWS.length * SEATS_PER_ROW;

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

async function getInventory() {
  const { rows } = await db.query(`
    SELECT
      SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available,
      SUM(CASE WHEN status = 'held'      THEN 1 ELSE 0 END) AS held,
      SUM(CASE WHEN status = 'booked'    THEN 1 ELSE 0 END) AS booked
    FROM seats
  `);
  return {
    available: parseInt(rows[0].available, 10),
    held: parseInt(rows[0].held, 10),
    booked: parseInt(rows[0].booked, 10),
  };
}

describe('Concurrent hold requests for the same seat', () => {
  test('exactly one of N concurrent holds for the same seat succeeds', async () => {
    const N = 10;
    const promises = Array.from({ length: N }, (_, i) =>
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: `concurrent-sess-${i}` })
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);

    // Inventory must balance
    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('exactly one of N concurrent holds for a seat group succeeds', async () => {
    const N = 8;
    const promises = Array.from({ length: N }, (_, i) =>
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['B1', 'B2'], sessionId: `group-sess-${i}` })
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('concurrent confirms of the same hold book seats exactly once', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2'], sessionId: 'confirm-owner' });
    expect(holdRes.status).toBe(201);
    const { holdId } = holdRes.body;

    const N = 5;
    const promises = Array.from({ length: N }, () =>
      request(app)
        .post(`/api/holds/${holdId}/confirm`)
        .send({ sessionId: 'confirm-owner' })
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 200);
    expect(successes).toHaveLength(N); // all return 200 (idempotent)

    // But seats are booked exactly once
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM seats WHERE id IN ('C1','C2') AND status = 'booked'`
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(2);

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('no seat ends up booked by two different sessions', async () => {
    // Two sessions race to hold D1, then both try to confirm
    const [r1, r2] = await Promise.all([
      request(app).post('/api/holds').send({ seatIds: ['D1'], sessionId: 'race-sess-1' }),
      request(app).post('/api/holds').send({ seatIds: ['D1'], sessionId: 'race-sess-2' }),
    ]);

    const winner = [r1, r2].find((r) => r.status === 201);
    expect(winner).toBeDefined();

    // Confirm the winner
    await request(app)
      .post(`/api/holds/${winner.body.holdId}/confirm`)
      .send({ sessionId: winner.body.sessionId });

    // Verify D1 is booked by exactly one session
    const { rows } = await db.query(
      `SELECT booked_by FROM seats WHERE id = 'D1' AND status = 'booked'`
    );
    expect(rows).toHaveLength(1);
    expect(['race-sess-1', 'race-sess-2']).toContain(rows[0].booked_by);

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('many concurrent holds across different seats all succeed', async () => {
    // Each request targets a unique seat – all should succeed
    const seats = ['E1', 'E2', 'E3', 'E4', 'E5'];
    const promises = seats.map((seatId, i) =>
      request(app)
        .post('/api/holds')
        .send({ seatIds: [seatId], sessionId: `unique-sess-${i}` })
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 201);
    expect(successes).toHaveLength(seats.length);

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });
});
