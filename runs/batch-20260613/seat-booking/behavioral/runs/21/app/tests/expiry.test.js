import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { initSchema } from '../backend/db.js';
import { createApp } from '../backend/app.js';
import { releaseExpiredHolds } from '../backend/holdExpiry.js';
import http from 'http';

/**
 * Create a test context with a very short TTL by directly manipulating the DB.
 */
async function createTestContext() {
  const db = new PGlite();
  await db.waitReady;
  await initSchema(db);

  const app = createApp(db);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  return {
    db,
    app,
    server,
    port,
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
    },
  };
}

function api(baseUrl) {
  return {
    async getSeats() {
      const res = await fetch(`${baseUrl}/api/seats`);
      return { status: res.status, data: await res.json() };
    },
    async hold(seatIds, sessionId) {
      const res = await fetch(`${baseUrl}/api/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds, sessionId }),
      });
      return { status: res.status, data: await res.json() };
    },
    async confirm(holdId) {
      const res = await fetch(`${baseUrl}/api/holds/${holdId}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      return { status: res.status, data: await res.json() };
    },
  };
}

describe('Hold Expiry', () => {
  let ctx;
  let client;

  beforeEach(async () => {
    ctx = await createTestContext();
    client = api(ctx.baseUrl);
  });

  afterEach(async () => {
    await ctx.close();
  });

  it('should release holds whose TTL has expired', async () => {
    const { data: seatsData } = await client.getSeats();
    const seatId = seatsData.seats[0].id;

    // Create a hold
    const { data: holdData } = await client.hold([seatId], 'session-1');
    expect(holdData.holdId).toBeTruthy();

    // Verify it's held
    const { data: heldData } = await client.getSeats();
    expect(heldData.seats.find(s => s.id === seatId).status).toBe('held');

    // Manually expire the hold by setting hold_expires_at to the past
    await ctx.db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdData.holdId]
    );

    // Run expiry sweep
    await releaseExpiredHolds(ctx.db);

    // Verify the seat is available again
    const { data: afterData } = await client.getSeats();
    expect(afterData.seats.find(s => s.id === seatId).status).toBe('available');
  });

  it('should show expired holds as available in GET /api/seats', async () => {
    const { data: seatsData } = await client.getSeats();
    const seatId = seatsData.seats[0].id;

    const { data: holdData } = await client.hold([seatId], 'session-1');

    // Manually expire the hold
    await ctx.db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdData.holdId]
    );

    // GET seats should show the seat as available (lazy expiry on read)
    const { data: afterData } = await client.getSeats();
    expect(afterData.seats.find(s => s.id === seatId).status).toBe('available');
  });

  it('should reject confirmation of expired hold', async () => {
    const { data: seatsData } = await client.getSeats();
    const seatId = seatsData.seats[0].id;

    const { data: holdData } = await client.hold([seatId], 'session-1');

    // Manually expire the hold
    await ctx.db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdData.holdId]
    );

    // Trying to confirm should fail
    const { status } = await client.confirm(holdData.holdId);
    expect(status).toBeGreaterThanOrEqual(400);

    // Seat should be available
    const { data: afterData } = await client.getSeats();
    expect(afterData.seats.find(s => s.id === seatId).status).toBe('available');
  });

  it('should allow another user to hold a seat after previous hold expires', async () => {
    const { data: seatsData } = await client.getSeats();
    const seatId = seatsData.seats[0].id;

    // Session 1 holds the seat
    const { data: holdData } = await client.hold([seatId], 'session-1');

    // Expire it
    await ctx.db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdData.holdId]
    );

    // Release expired holds
    await releaseExpiredHolds(ctx.db);

    // Session 2 should be able to hold the same seat
    const { status } = await client.hold([seatId], 'session-2');
    expect(status).toBe(201);
  });

  it('inventory remains consistent after expiry', async () => {
    const { data: seatsData } = await client.getSeats();
    const total = seatsData.seats.length;

    // Hold 5 seats
    const seatIds = seatsData.seats.slice(0, 5).map(s => s.id);
    const { data: holdData } = await client.hold(seatIds, 'session-1');

    // Expire 3 of them
    const expiredIds = seatIds.slice(0, 3);
    const placeholders = expiredIds.map((_, i) => `$${i + 1}`).join(', ');
    await ctx.db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE id IN (${placeholders})`,
      expiredIds
    );

    // Run expiry
    await releaseExpiredHolds(ctx.db);

    // Check inventory
    const { data: afterData } = await client.getSeats();
    const available = afterData.seats.filter(s => s.status === 'available').length;
    const held = afterData.seats.filter(s => s.status === 'held').length;
    const booked = afterData.seats.filter(s => s.status === 'booked').length;

    expect(available + held + booked).toBe(total);
    expect(available).toBe(total - 2); // 3 expired + 45 originally available = 48
    expect(held).toBe(2); // 2 still held
    expect(booked).toBe(0);
  });
});
