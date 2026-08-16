/**
 * Tests for POST /api/holds/:holdId/confirm
 */

import { buildApp, request } from './helpers.js';

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

describe('POST /api/holds/:holdId/confirm – validation', () => {
  test('returns 410 for unknown holdId', async () => {
    const res = await request(app)
      .post('/api/holds/nonexistent-hold/confirm')
      .send({ sessionId: 'sess-1' });
    expect(res.status).toBe(410);
  });

  test('returns 400 when sessionId is missing', async () => {
    const res = await request(app)
      .post('/api/holds/any-hold/confirm')
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/holds/:holdId/confirm – happy path', () => {
  test('confirms a valid hold and books the seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-2' });
    expect(holdRes.status).toBe(201);
    const { holdId } = holdRes.body;

    const confirmRes = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-2' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.seatIds).toEqual(expect.arrayContaining(['A1', 'A2']));
  });

  test('booked seats appear as booked in GET /api/seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-3' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-3' });

    const seatsRes = await request(app).get('/api/seats');
    const b1 = seatsRes.body.find((s) => s.id === 'B1');
    expect(b1.status).toBe('booked');
  });

  test('booked seats cannot be held by another session', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'sess-4' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-4' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'sess-5' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/holds/:holdId/confirm – idempotency', () => {
  test('confirming the same hold twice returns 200 both times', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'sess-6' });
    const { holdId } = holdRes.body;

    const first = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-6' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-6' });
    expect(second.status).toBe(200);
    expect(second.body.alreadyConfirmed).toBe(true);
  });

  test('seat is booked exactly once after two confirms', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1'], sessionId: 'sess-7' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-7' });
    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-7' });

    // Verify only one booking in DB
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM seats WHERE id = 'E1' AND status = 'booked'`
    );
    expect(parseInt(rows[0].cnt, 10)).toBe(1);
  });
});

describe('POST /api/holds/:holdId/confirm – expiry', () => {
  test('returns 410 when confirming an expired hold', async () => {
    // Manually create an expired hold
    const holdId = 'expired-confirm-test';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-8', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'A3'`,
      [holdId, pastTime]
    );

    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-8' });

    expect(res.status).toBe(410);
  });

  test('expired hold does not book any seats', async () => {
    const holdId = 'expired-no-book-test';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-9', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'A4'`,
      [holdId, pastTime]
    );

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-9' });

    const { rows } = await db.query(
      `SELECT status FROM seats WHERE id = 'A4'`
    );
    expect(rows[0].status).not.toBe('booked');
  });
});

describe('POST /api/holds/:holdId/confirm – ownership', () => {
  test('returns 403 when wrong sessionId tries to confirm', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B2'], sessionId: 'owner-sess' });
    const { holdId } = holdRes.body;

    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'thief-sess' });

    expect(res.status).toBe(403);
  });
});
