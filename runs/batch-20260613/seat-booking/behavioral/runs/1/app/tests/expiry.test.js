/**
 * Tests for hold expiry behaviour.
 */

import { buildApp, request } from './helpers.js';
import { sweepExpiredHolds } from '../server/src/db.js';

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

describe('Hold expiry', () => {
  test('sweepExpiredHolds releases expired holds', async () => {
    const holdId = 'sweep-test-hold';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-sweep', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'A1'`,
      [holdId, pastTime]
    );

    const released = await sweepExpiredHolds(db);
    expect(released).toContain('A1');

    const { rows } = await db.query(`SELECT status FROM seats WHERE id = 'A1'`);
    expect(rows[0].status).toBe('available');
  });

  test('sweepExpiredHolds does not release active holds', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-active' });
    expect(holdRes.status).toBe(201);

    const released = await sweepExpiredHolds(db);
    expect(released).not.toContain('B1');

    const { rows } = await db.query(`SELECT status FROM seats WHERE id = 'B1'`);
    expect(rows[0].status).toBe('held');
  });

  test('sweepExpiredHolds does not release confirmed holds', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'sess-confirm' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-confirm' });

    // Manually expire the hold record (even though it's confirmed)
    await db.query(
      `UPDATE holds SET expires_at = $1 WHERE id = $2`,
      [new Date(Date.now() - 5000).toISOString(), holdId]
    );

    const released = await sweepExpiredHolds(db);
    expect(released).not.toContain('C1');

    const { rows } = await db.query(`SELECT status FROM seats WHERE id = 'C1'`);
    expect(rows[0].status).toBe('booked');
  });

  test('GET /api/seats triggers lazy expiry and returns available for expired holds', async () => {
    const holdId = 'lazy-expiry-test';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-lazy', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'D1'`,
      [holdId, pastTime]
    );

    const res = await request(app).get('/api/seats');
    const d1 = res.body.find((s) => s.id === 'D1');
    expect(d1.status).toBe('available');
  });

  test('expired seat can be held by a new session after expiry', async () => {
    const holdId = 'rehold-after-expiry';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-old', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'E1'`,
      [holdId, pastTime]
    );

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1'], sessionId: 'sess-new' });

    expect(res.status).toBe(201);
    expect(res.body.seatIds).toContain('E1');
  });

  test('confirming an expired hold returns 410 and does not book', async () => {
    const holdId = 'expired-confirm-expiry-test';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'sess-exp', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'A5'`,
      [holdId, pastTime]
    );

    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-exp' });

    expect(res.status).toBe(410);

    const { rows } = await db.query(`SELECT status FROM seats WHERE id = 'A5'`);
    expect(rows[0].status).not.toBe('booked');
  });
});
