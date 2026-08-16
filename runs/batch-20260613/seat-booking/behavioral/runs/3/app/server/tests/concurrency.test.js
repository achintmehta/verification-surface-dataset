/**
 * Concurrency tests.
 *
 * These tests fire many simultaneous requests for the same seat(s) and verify
 * that exactly one succeeds and the rest receive 409.
 *
 * PGLite is single-connection (serialised), so our FOR UPDATE locking inside
 * a transaction guarantees correctness.
 */

import request from 'supertest';
import { createApp } from '../src/index.js';
import { getDb, resetDb } from '../src/db.js';

let app;

beforeEach(async () => {
  process.env.PGLITE_DATA_DIR = ':memory:';
  process.env.HOLD_TTL_SECONDS = '60';
  resetDb();
  app = await createApp();
  await getDb();
});

afterEach(() => {
  resetDb();
});

describe('Concurrency: simultaneous hold requests for the same seat', () => {
  test('exactly one of N concurrent requests for the same seat succeeds', async () => {
    const N = 10;
    const promises = Array.from({ length: N }, (_, i) =>
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: `sess-${i}` })
    );

    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 201);
    const conflicts = results.filter(r => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(N - 1);
  });

  test('seat is held exactly once after concurrent requests', async () => {
    const N = 8;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        request(app)
          .post('/api/holds')
          .send({ seatIds: ['B5'], sessionId: `sess-${i}` })
      )
    );

    const seatsRes = await request(app).get('/api/seats');
    const b5 = seatsRes.body.find(s => s.id === 'B5');
    expect(b5.status).toBe('held');

    // Inventory must still balance.
    const held = seatsRes.body.filter(s => s.status === 'held').length;
    const available = seatsRes.body.filter(s => s.status === 'available').length;
    const booked = seatsRes.body.filter(s => s.status === 'booked').length;
    expect(held + available + booked).toBe(50);
    expect(held).toBe(1);
  });

  test('concurrent requests for different seats all succeed', async () => {
    const seatIds = ['A1', 'A2', 'A3', 'A4', 'A5'];
    const promises = seatIds.map((id, i) =>
      request(app)
        .post('/api/holds')
        .send({ seatIds: [id], sessionId: `sess-${i}` })
    );

    const results = await Promise.all(promises);
    const successes = results.filter(r => r.status === 201);
    expect(successes).toHaveLength(seatIds.length);
  });

  test('all-or-nothing: concurrent overlapping multi-seat holds', async () => {
    // Two sessions both want A1+A2; only one can win.
    const [r1, r2] = await Promise.all([
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-1' }),
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-2' }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Inventory must balance.
    const seatsRes = await request(app).get('/api/seats');
    const held = seatsRes.body.filter(s => s.status === 'held').length;
    expect(held).toBe(2);
  });

  test('no seat is booked by two different sessions', async () => {
    // Both sessions try to hold and confirm A1.
    const [h1, h2] = await Promise.all([
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: 'sess-1' }),
      request(app)
        .post('/api/holds')
        .send({ seatIds: ['A1'], sessionId: 'sess-2' }),
    ]);

    // Confirm whichever succeeded.
    const winner = h1.status === 201 ? h1 : h2;
    const winnerSession = h1.status === 201 ? 'sess-1' : 'sess-2';

    const confirmRes = await request(app)
      .post(`/api/holds/${winner.body.holdId}/confirm`)
      .send({ sessionId: winnerSession });

    expect(confirmRes.status).toBe(200);

    // A1 is booked exactly once.
    const seatsRes = await request(app).get('/api/seats');
    const a1 = seatsRes.body.find(s => s.id === 'A1');
    expect(a1.status).toBe('booked');
  });

  test('concurrent confirms of the same hold book seats exactly once', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    // Fire 5 concurrent confirms.
    const confirms = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/holds/${holdId}/confirm`)
          .send({ sessionId: 'sess-1' })
      )
    );

    // All should succeed (idempotent).
    confirms.forEach(r => expect(r.status).toBe(200));

    // Seats booked exactly once.
    const seatsRes = await request(app).get('/api/seats');
    const booked = seatsRes.body.filter(s => s.status === 'booked');
    expect(booked).toHaveLength(2);
    expect(booked.map(s => s.id)).toEqual(expect.arrayContaining(['C1', 'C2']));
  });
});
