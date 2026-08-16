/**
 * Inventory accounting tests.
 *
 * Verifies that available + held(active) + booked always equals 50 (total seats)
 * across a variety of operations.
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

const TOTAL_SEATS = 50;

async function getInventory() {
  const res = await request(app).get('/api/seats');
  const seats = res.body;
  const available = seats.filter(s => s.status === 'available').length;
  const held = seats.filter(s => s.status === 'held').length;
  const booked = seats.filter(s => s.status === 'booked').length;
  return { available, held, booked, total: seats.length };
}

describe('Inventory accounting', () => {
  test('initial inventory: all 50 available', async () => {
    const inv = await getInventory();
    expect(inv.total).toBe(TOTAL_SEATS);
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
  });

  test('after hold: available decreases, held increases', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'sess-1' });

    const inv = await getInventory();
    expect(inv.available).toBe(47);
    expect(inv.held).toBe(3);
    expect(inv.booked).toBe(0);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after confirm: held decreases, booked increases', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2'], sessionId: 'sess-1' });

    await request(app)
      .post(`/api/holds/${holdRes.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const inv = await getInventory();
    expect(inv.available).toBe(48);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(2);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after release: held decreases, available increases', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2', 'C3'], sessionId: 'sess-1' });

    await request(app)
      .delete(`/api/holds/${holdRes.body.holdId}`)
      .send({ sessionId: 'sess-1' });

    const inv = await getInventory();
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after expiry: held decreases, available increases', async () => {
    process.env.HOLD_TTL_SECONDS = '0';
    resetDb();
    app = await createApp();
    await getDb();

    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1', 'D2'], sessionId: 'sess-1' });

    await new Promise(r => setTimeout(r, 50));

    // GET /api/seats triggers lazy expiry.
    const inv = await getInventory();
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('mixed operations keep inventory balanced', async () => {
    // Hold 5 seats for sess-1.
    const h1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3', 'A4', 'A5'], sessionId: 'sess-1' });

    // Hold 3 seats for sess-2.
    const h2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2', 'B3'], sessionId: 'sess-2' });

    // Confirm sess-1's hold.
    await request(app)
      .post(`/api/holds/${h1.body.holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    // Release sess-2's hold.
    await request(app)
      .delete(`/api/holds/${h2.body.holdId}`)
      .send({ sessionId: 'sess-2' });

    const inv = await getInventory();
    expect(inv.available).toBe(45);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(5);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('idempotent confirm does not double-count booked seats', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1', 'E2'], sessionId: 'sess-1' });
    const holdId = holdRes.body.holdId;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-1' });
    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-1' });

    const inv = await getInventory();
    expect(inv.booked).toBe(2);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });
});
