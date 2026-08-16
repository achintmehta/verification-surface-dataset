/**
 * Tests for GET /api/seats
 */

import { buildApp, request } from './helpers.js';

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

describe('GET /api/seats', () => {
  test('returns all 50 seats (5 rows × 10 seats)', async () => {
    const res = await request(app).get('/api/seats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(50);
  });

  test('all seats start as available', async () => {
    const res = await request(app).get('/api/seats');
    const statuses = res.body.map((s) => s.status);
    expect(statuses.every((s) => s === 'available')).toBe(true);
  });

  test('seats are ordered by row then seat number', async () => {
    const res = await request(app).get('/api/seats');
    const seats = res.body;
    // First seat should be A1
    expect(seats[0].row_label).toBe('A');
    expect(seats[0].seat_number).toBe(1);
    // Last seat should be E10
    expect(seats[49].row_label).toBe('E');
    expect(seats[49].seat_number).toBe(10);
  });

  test('seat objects have required fields', async () => {
    const res = await request(app).get('/api/seats');
    const seat = res.body[0];
    expect(seat).toHaveProperty('id');
    expect(seat).toHaveProperty('row_label');
    expect(seat).toHaveProperty('seat_number');
    expect(seat).toHaveProperty('status');
  });

  test('held seat with expired TTL is reported as available', async () => {
    // Manually insert an expired hold and mark a seat as held
    const holdId = 'expired-hold-test';
    const pastTime = new Date(Date.now() - 10000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'session-x', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'A1'`,
      [holdId, pastTime]
    );

    const res = await request(app).get('/api/seats');
    const a1 = res.body.find((s) => s.id === 'A1');
    expect(a1.status).toBe('available');

    // Verify DB was also cleaned up
    const { rows } = await db.query(`SELECT status FROM seats WHERE id = 'A1'`);
    expect(rows[0].status).toBe('available');
  });
});
