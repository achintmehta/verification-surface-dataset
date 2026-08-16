/**
 * Hold expiry tests.
 *
 * Verifies that expired holds are automatically released and their seats
 * become available again.
 */

import request from 'supertest';
import { createApp } from '../src/index.js';
import { getDb, resetDb } from '../src/db.js';
import { releaseExpiredHolds } from '../src/expiry.js';

let app;

beforeEach(async () => {
  process.env.PGLITE_DATA_DIR = ':memory:';
  process.env.HOLD_TTL_SECONDS = '0'; // Immediate expiry for tests.
  resetDb();
  app = await createApp();
  await getDb();
});

afterEach(() => {
  resetDb();
});

describe('Hold expiry', () => {
  test('expired hold releases seats on GET /api/seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-1' });
    expect(holdRes.status).toBe(201);

    await new Promise(r => setTimeout(r, 50));

    const seatsRes = await request(app).get('/api/seats');
    const a1 = seatsRes.body.find(s => s.id === 'A1');
    const a2 = seatsRes.body.find(s => s.id === 'A2');
    expect(a1.status).toBe('available');
    expect(a2.status).toBe('available');
  });

  test('expired seat can be held by another session', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-2' });

    expect(res.status).toBe(201);
  });

  test('confirming an expired hold returns 410', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    const confirmRes = await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    expect(confirmRes.status).toBe(410);
  });

  test('confirming expired hold does not book the seat', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const seatsRes = await request(app).get('/api/seats');
    const d1 = seatsRes.body.find(s => s.id === 'D1');
    expect(d1.status).toBe('available');
  });

  test('releaseExpiredHolds frees seats directly', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1', 'E2', 'E3'], sessionId: 'sess-1' });
    expect(holdRes.status).toBe(201);

    await new Promise(r => setTimeout(r, 50));

    const db = await getDb();
    const freed = await releaseExpiredHolds(db);
    expect(freed.length).toBeGreaterThanOrEqual(3);

    const seatsRes = await request(app).get('/api/seats');
    const e1 = seatsRes.body.find(s => s.id === 'E1');
    expect(e1.status).toBe('available');
  });

  test('expiry before hold: new hold succeeds after expiry', async () => {
    // Hold A1 with immediate expiry.
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    // New hold for A1 should succeed.
    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1'], sessionId: 'sess-2' });

    expect(res.status).toBe(201);
    expect(res.body.seatIds).toContain('A1');
  });

  test('inventory balances after expiry', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3', 'A4', 'A5'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    const seatsRes = await request(app).get('/api/seats');
    const available = seatsRes.body.filter(s => s.status === 'available').length;
    const held = seatsRes.body.filter(s => s.status === 'held').length;
    const booked = seatsRes.body.filter(s => s.status === 'booked').length;

    expect(available + held + booked).toBe(50);
    expect(available).toBe(50);
    expect(held).toBe(0);
  });
});
