/**
 * Tests for GET /api/seats
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
  // Ensure DB is initialised.
  await getDb();
});

afterEach(() => {
  resetDb();
});

describe('GET /api/seats', () => {
  test('returns all 50 seats (5 rows × 10)', async () => {
    const res = await request(app).get('/api/seats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(50);
  });

  test('all seats start as available', async () => {
    const res = await request(app).get('/api/seats');
    const statuses = res.body.map(s => s.status);
    expect(statuses.every(s => s === 'available')).toBe(true);
  });

  test('seats are ordered by row_label then seat_number', async () => {
    const res = await request(app).get('/api/seats');
    const seats = res.body;
    for (let i = 1; i < seats.length; i++) {
      const prev = seats[i - 1];
      const curr = seats[i];
      const rowOk = prev.row_label < curr.row_label ||
        (prev.row_label === curr.row_label && prev.seat_number < curr.seat_number);
      expect(rowOk).toBe(true);
    }
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
    process.env.HOLD_TTL_SECONDS = '0';
    resetDb();
    app = await createApp();
    await getDb();

    // Create a hold that immediately expires.
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-1' });
    expect(holdRes.status).toBe(201);

    // Wait a tick for expiry.
    await new Promise(r => setTimeout(r, 50));

    const seatsRes = await request(app).get('/api/seats');
    const a1 = seatsRes.body.find(s => s.id === 'A1');
    expect(a1.status).toBe('available');
  });
});
