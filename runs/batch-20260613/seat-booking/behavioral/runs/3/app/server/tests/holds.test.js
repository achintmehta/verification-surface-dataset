/**
 * Tests for POST /api/holds, POST /api/holds/:id/confirm, DELETE /api/holds/:id
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

/* ------------------------------------------------------------------ */
/* POST /api/holds                                                       */
/* ------------------------------------------------------------------ */
describe('POST /api/holds', () => {
  test('creates a hold for available seats', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-1' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('holdId');
    expect(res.body.seatIds).toEqual(expect.arrayContaining(['A1', 'A2']));
    expect(res.body).toHaveProperty('expiresAt');
    expect(res.body.ttlSeconds).toBe(60);
  });

  test('held seats appear as held in GET /api/seats', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B3'], sessionId: 'sess-1' });

    const seatsRes = await request(app).get('/api/seats');
    const b3 = seatsRes.body.find(s => s.id === 'B3');
    expect(b3.status).toBe('held');
  });

  test('returns 409 when any seat is already held', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-1' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-2' });

    expect(res.status).toBe(409);
    expect(res.body.conflictingSeatIds).toContain('A1');
  });

  test('all-or-nothing: no seats held when one conflicts', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-1' });

    // Try to hold A1 and A2 together; A1 is taken.
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-2' });

    expect(res.status).toBe(409);

    // A2 must still be available.
    const seatsRes = await request(app).get('/api/seats');
    const a2 = seatsRes.body.find(s => s.id === 'A2');
    expect(a2.status).toBe('available');
  });

  test('returns 400 for missing seatIds', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for empty seatIds array', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: [], sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });

  test('returns 400 for missing sessionId', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'] });
    expect(res.status).toBe(400);
  });

  test('returns 404 for non-existent seat ids', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['Z99'], sessionId: 'sess-1' });
    expect(res.status).toBe(404);
  });

  test('deduplicates seat ids in request', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A1', 'A1'], sessionId: 'sess-1' });
    expect(res.status).toBe(201);
    expect(res.body.seatIds).toHaveLength(1);
  });

  test('returns 409 when seat is already booked', async () => {
    // Hold and confirm A1.
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-1' });
    await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    // Try to hold A1 again.
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-2' });
    expect(res.status).toBe(409);
  });
});

/* ------------------------------------------------------------------ */
/* POST /api/holds/:holdId/confirm                                       */
/* ------------------------------------------------------------------ */
describe('POST /api/holds/:holdId/confirm', () => {
  test('confirms a valid hold and books the seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C5', 'C6'], sessionId: 'sess-1' });

    const confirmRes = await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.booked).toBe(true);
    expect(confirmRes.body.seatIds).toEqual(expect.arrayContaining(['C5', 'C6']));
  });

  test('booked seats appear as booked in GET /api/seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'sess-1' });

    await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const seatsRes = await request(app).get('/api/seats');
    const d1 = seatsRes.body.find(s => s.id === 'D1');
    expect(d1.status).toBe('booked');
  });

  test('idempotent: confirming twice returns same result, books once', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    const first = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-1' });
    const second = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.booked).toBe(true);

    // Seat is booked exactly once.
    const seatsRes = await request(app).get('/api/seats');
    const e1 = seatsRes.body.find(s => s.id === 'E1');
    expect(e1.status).toBe('booked');
  });

  test('returns 404 for unknown hold id', async () => {
    const res = await request(app)
      .post('/api/holds/nonexistent-hold/confirm')
      .send({ sessionId: 'sess-1' });
    expect(res.status).toBe(404);
  });

  test('returns 403 when sessionId does not match hold owner', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A3'], sessionId: 'sess-1' });

    const res = await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-WRONG' });

    expect(res.status).toBe(403);
  });

  test('returns 410 for expired hold', async () => {
    process.env.HOLD_TTL_SECONDS = '0';
    resetDb();
    app = await createApp();
    await getDb();

    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A4'], sessionId: 'sess-1' });

    // Wait for expiry.
    await new Promise(r => setTimeout(r, 50));

    const res = await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    expect(res.status).toBe(410);
  });

  test('expired hold does not book the seat', async () => {
    process.env.HOLD_TTL_SECONDS = '0';
    resetDb();
    app = await createApp();
    await getDb();

    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A5'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const seatsRes = await request(app).get('/api/seats');
    const a5 = seatsRes.body.find(s => s.id === 'A5');
    expect(a5.status).toBe('available');
  });

  test('returns 400 for missing sessionId', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A6'], sessionId: 'sess-1' });

    const res = await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({});

    expect(res.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* DELETE /api/holds/:holdId                                             */
/* ------------------------------------------------------------------ */
describe('DELETE /api/holds/:holdId', () => {
  test('releases a hold and returns seats to available', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    const delRes = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-1' });

    expect(delRes.status).toBe(200);
    expect(delRes.body.released).toBe(true);

    const seatsRes = await request(app).get('/api/seats');
    const b1 = seatsRes.body.find(s => s.id === 'B1');
    const b2 = seatsRes.body.find(s => s.id === 'B2');
    expect(b1.status).toBe('available');
    expect(b2.status).toBe('available');
  });

  test('returns 404 for unknown hold', async () => {
    const res = await request(app)
      .delete('/api/holds/no-such-hold')
      .send({ sessionId: 'sess-1' });
    expect(res.status).toBe(404);
  });

  test('returns 403 when sessionId does not match', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'sess-1' });

    const res = await request(app)
      .delete(`/api/holds/${holdRes.body.holdId}`)
      .send({ sessionId: 'sess-WRONG' });

    expect(res.status).toBe(403);
  });

  test('returns 409 when trying to release a confirmed hold', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C2'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const res = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-1' });

    expect(res.status).toBe(409);
  });

  test('released seats can be held by another session', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D5'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-1' });

    const newHold = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D5'], sessionId: 'sess-2' });

    expect(newHold.status).toBe(201);
  });
});
