/**
 * Inventory reconciliation tests.
 *
 * At all times: available + held(active) + booked = total seats (50).
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

describe('Inventory reconciliation', () => {
  test('initial inventory: all seats available', async () => {
    const inv = await getInventory();
    expect(inv.available).toBe(TOTAL_SEATS);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after holding seats, inventory balances', async () => {
    await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2', 'A3'], sessionId: 'inv-sess-1' });

    const inv = await getInventory();
    expect(inv.held).toBe(3);
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after confirming a hold, inventory balances', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1', 'B2'], sessionId: 'inv-sess-2' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'inv-sess-2' });

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after releasing a hold, inventory balances', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1', 'C2'], sessionId: 'inv-sess-3' });
    const { holdId } = holdRes.body;

    await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'inv-sess-3' });

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('after expiry sweep, inventory balances', async () => {
    const holdId = 'inv-expired-hold';
    const pastTime = new Date(Date.now() - 5000).toISOString();

    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'inv-sess-4', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'D1'`,
      [holdId, pastTime]
    );

    // Trigger lazy sweep via GET /api/seats
    await request(app).get('/api/seats');

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });

  test('complex sequence: hold, confirm, hold, release, hold, expire – inventory always balances', async () => {
    // Hold E1, E2
    const h1 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E1', 'E2'], sessionId: 'complex-1' });
    let inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);

    // Confirm E1, E2
    await request(app)
      .post(`/api/holds/${h1.body.holdId}/confirm`)
      .send({ sessionId: 'complex-1' });
    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);

    // Hold E3, E4
    const h2 = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['E3', 'E4'], sessionId: 'complex-2' });
    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);

    // Release E3, E4
    await request(app)
      .delete(`/api/holds/${h2.body.holdId}`)
      .send({ sessionId: 'complex-2' });
    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);

    // Expire E5 hold
    const holdId = 'complex-expire';
    const pastTime = new Date(Date.now() - 5000).toISOString();
    await db.query(
      `INSERT INTO holds (id, session_id, expires_at) VALUES ($1, $2, $3)`,
      [holdId, 'complex-3', pastTime]
    );
    await db.query(
      `UPDATE seats SET status = 'held', hold_id = $1, hold_expires_at = $2 WHERE id = 'E5'`,
      [holdId, pastTime]
    );
    await request(app).get('/api/seats'); // trigger sweep
    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(TOTAL_SEATS);
  });
});
