/**
 * Tests for DELETE /api/holds/:holdId
 */

import { buildApp, request } from './helpers.js';

let app, db;

beforeAll(async () => {
  ({ app, db } = await buildApp());
});

describe('DELETE /api/holds/:holdId', () => {
  test('releases a hold and returns seats to available', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['A1', 'A2'], sessionId: 'sess-1' });
    const { holdId } = holdRes.body;

    const delRes = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-1' });
    expect(delRes.status).toBe(200);
    expect(delRes.body.released).toEqual(expect.arrayContaining(['A1', 'A2']));

    // Seats should be available again
    const seatsRes = await request(app).get('/api/seats');
    const a1 = seatsRes.body.find((s) => s.id === 'A1');
    const a2 = seatsRes.body.find((s) => s.id === 'A2');
    expect(a1.status).toBe('available');
    expect(a2.status).toBe('available');
  });

  test('released seats can be held by another session', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-2' });
    const { holdId } = holdRes.body;

    await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-2' });

    const res = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['B1'], sessionId: 'sess-3' });
    expect(res.status).toBe(201);
  });

  test('deleting a non-existent hold returns 200 (idempotent)', async () => {
    const res = await request(app)
      .delete('/api/holds/does-not-exist')
      .send({ sessionId: 'sess-4' });
    expect(res.status).toBe(200);
  });

  test('returns 403 when wrong session tries to delete', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['C1'], sessionId: 'owner-sess' });
    const { holdId } = holdRes.body;

    const res = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'thief-sess' });
    expect(res.status).toBe(403);

    // Seat should still be held
    const seatsRes = await request(app).get('/api/seats');
    const c1 = seatsRes.body.find((s) => s.id === 'C1');
    expect(c1.status).toBe('held');
  });

  test('cannot release a confirmed hold', async () => {
    const holdRes = await request(app)
      .post('/api/holds')
      .send({ seatIds: ['D1'], sessionId: 'sess-5' });
    const { holdId } = holdRes.body;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: 'sess-5' });

    const res = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: 'sess-5' });
    expect(res.status).toBe(409);

    // Seat should still be booked
    const seatsRes = await request(app).get('/api/seats');
    const d1 = seatsRes.body.find((s) => s.id === 'D1');
    expect(d1.status).toBe('booked');
  });
});
