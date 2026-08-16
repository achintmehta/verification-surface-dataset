/**
 * Tests for POST /api/holds
 */

import { buildApp, request } from './helpers.js';

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

describe('POST /api/holds – validation', () => {
  test('rejects missing seatIds', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });

  test('rejects empty seatIds array', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: [], sessionId: 'sess-1' });
    expect(res.status).toBe(400);
  });

  test('rejects missing sessionId', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'] });
    expect(res.status).toBe(400);
  });

  test('rejects unknown seat ids', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['Z99'], sessionId: 'sess-1' });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('unknownIds');
  });
});

describe('POST /api/holds – happy path', () => {
  test('creates a hold for a single seat', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-2' });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('holdId');
    expect(res.body.seatIds).toEqual(['B1']);
    expect(res.body).toHaveProperty('expiresAt');
  });

  test('creates a hold for multiple seats', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2', 'C3'], sessionId: 'sess-3' });
    expect(res.status).toBe(201);
    expect(res.body.seatIds).toHaveLength(3);
  });

  test('held seats appear as held in GET /api/seats', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'sess-4' });

    const res = await request(app).get('/api/seats');
    const d1 = res.body.find((s) => s.id === 'D1');
    expect(d1.status).toBe('held');
  });

  test('expiresAt is in the future', async () => {
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1'], sessionId: 'sess-5' });
    expect(res.status).toBe(201);
    const expiresAt = new Date(res.body.expiresAt);
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('POST /api/holds – conflict (409)', () => {
  test('returns 409 when requesting an already-held seat', async () => {
    // Hold A2
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A2'], sessionId: 'sess-6' });

    // Try to hold A2 again
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A2'], sessionId: 'sess-7' });

    expect(res.status).toBe(409);
    expect(res.body.conflictIds).toContain('A2');
  });

  test('returns 409 when requesting a booked seat', async () => {
    // Hold and confirm A3
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A3'], sessionId: 'sess-8' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-8' });

    // Try to hold A3
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A3'], sessionId: 'sess-9' });

    expect(res.status).toBe(409);
    expect(res.body.conflictIds).toContain('A3');
  });

  test('all-or-nothing: if one seat is unavailable, none are acquired', async () => {
    // Hold A4
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A4'], sessionId: 'sess-10' });

    // Try to hold A4 + A5 (A5 is free, A4 is not)
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A4', 'A5'], sessionId: 'sess-11' });

    expect(res.status).toBe(409);

    // A5 must still be available
    const seatsRes = await request(app).get('/api/seats');
    const a5 = seatsRes.body.find((s) => s.id === 'A5');
    expect(a5.status).toBe('available');
  });

  test('returns conflicting seat ids in the response', async () => {
    // Hold A6 and A7
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A6', 'A7'], sessionId: 'sess-12' });

    // Try to hold A6, A7, A8 (A8 is free)
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A6', 'A7', 'A8'], sessionId: 'sess-13' });

    expect(res.status).toBe(409);
    expect(res.body.conflictIds).toContain('A6');
    expect(res.body.conflictIds).toContain('A7');
    expect(res.body.conflictIds).not.toContain('A8');
  });
});

describe('POST /api/holds – expired hold treated as available', () => {
  test('can hold a seat whose previous hold has expired', async () => {
    // Manually expire the hold on B2
    const holdId = 'expired-hold-b2';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'old-session', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'B2'`,
      [holdId, pastTime]
    );

    // Now try to hold B2 – should succeed because the old hold is expired
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B2'], sessionId: 'sess-new' });

    expect(res.status).toBe(201);
    expect(res.body.seatIds).toContain('B2');
  });
});
