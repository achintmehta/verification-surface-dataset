import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestContext, api } from './setup.js';

describe('Seat Booking API', () => {
  let ctx;
  let client;

  beforeEach(async () => {
    ctx = await createTestContext();
    client = api(ctx.baseUrl);
  });

  afterEach(async () => {
    await ctx.close();
  });

  // ─── GET /api/seats ──────────────────────────────────────────

  describe('GET /api/seats', () => {
    it('should return all 50 seats', async () => {
      const { status, data } = await client.getSeats();
      expect(status).toBe(200);
      expect(data.seats).toHaveLength(50);
    });

    it('should return all seats as available initially', async () => {
      const { data } = await client.getSeats();
      for (const seat of data.seats) {
        expect(seat.status).toBe('available');
      }
    });

    it('should have correct row labels and seat numbers', async () => {
      const { data } = await client.getSeats();
      const rows = new Set(data.seats.map(s => s.row_label));
      expect(rows.size).toBe(5);
      expect([...rows].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);

      for (const row of rows) {
        const rowSeats = data.seats.filter(s => s.row_label === row);
        expect(rowSeats).toHaveLength(10);
        const seatNums = rowSeats.map(s => s.seat_number).sort((a, b) => a - b);
        expect(seatNums).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      }
    });
  });

  // ─── POST /api/holds ─────────────────────────────────────────

  describe('POST /api/holds', () => {
    it('should create a hold for available seats', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id, seatsData.seats[1].id];

      const { status, data } = await client.hold(seatIds, 'session-1');
      expect(status).toBe(201);
      expect(data.holdId).toBeTruthy();
      expect(data.expiresAt).toBeTruthy();
      expect(data.seats).toHaveLength(2);
    });

    it('should mark held seats as held', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id];

      await client.hold(seatIds, 'session-1');

      const { data: afterData } = await client.getSeats();
      const heldSeat = afterData.seats.find(s => s.id === seatIds[0]);
      expect(heldSeat.status).toBe('held');
    });

    it('should reject hold for already held seats (all-or-nothing)', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id, seatsData.seats[1].id];

      // First hold succeeds
      const { status: s1 } = await client.hold(seatIds, 'session-1');
      expect(s1).toBe(201);

      // Second hold on same seats fails (even with different session)
      const { status: s2, data: d2 } = await client.hold(seatIds, 'session-2');
      expect(s2).toBe(409);
      expect(d2.conflictingSeats).toBeTruthy();
      expect(d2.conflictingSeats.length).toBeGreaterThan(0);
    });

    it('should reject hold if ANY seat is unavailable (all-or-nothing)', async () => {
      const { data: seatsData } = await client.getSeats();
      const seat1 = seatsData.seats[0].id;
      const seat2 = seatsData.seats[1].id;
      const seat3 = seatsData.seats[2].id;

      // Hold seat1
      await client.hold([seat1], 'session-1');

      // Try to hold seat1 + seat2 + seat3 as session-2
      const { status, data } = await client.hold([seat1, seat2, seat3], 'session-2');
      expect(status).toBe(409);

      // Verify seat2 and seat3 were NOT held (all-or-nothing)
      const { data: afterData } = await client.getSeats();
      const s2 = afterData.seats.find(s => s.id === seat2);
      const s3 = afterData.seats.find(s => s.id === seat3);
      expect(s2.status).toBe('available');
      expect(s3.status).toBe('available');
    });

    it('should reject if seatIds is empty', async () => {
      const { status } = await client.hold([], 'session-1');
      expect(status).toBe(400);
    });

    it('should reject if sessionId is missing', async () => {
      const { data: seatsData } = await client.getSeats();
      const res = await fetch(`${ctx.baseUrl}/api/holds`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seatIds: [seatsData.seats[0].id] }),
      });
      expect(res.status).toBe(400);
    });
  });

  // ─── POST /api/holds/:holdId/confirm ─────────────────────────

  describe('POST /api/holds/:holdId/confirm', () => {
    it('should confirm a valid hold and book seats', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id, seatsData.seats[1].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');
      const { status, data } = await client.confirm(holdData.holdId);

      expect(status).toBe(200);
      expect(data.seats).toHaveLength(2);
      for (const seat of data.seats) {
        expect(seat.status).toBe('booked');
      }
    });

    it('should mark seats as booked after confirmation', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');
      await client.confirm(holdData.holdId);

      const { data: afterData } = await client.getSeats();
      const bookedSeat = afterData.seats.find(s => s.id === seatIds[0]);
      expect(bookedSeat.status).toBe('booked');
    });

    it('should be idempotent - confirming twice succeeds and books seats exactly once', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id, seatsData.seats[1].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');

      // First confirm
      const { status: s1, data: d1 } = await client.confirm(holdData.holdId);
      expect(s1).toBe(200);

      // Second confirm (idempotent)
      const { status: s2, data: d2 } = await client.confirm(holdData.holdId);
      expect(s2).toBe(200);
      expect(d2.seats).toHaveLength(2);

      // Verify seats are booked exactly once
      const { data: afterData } = await client.getSeats();
      const bookedSeats = afterData.seats.filter(s => s.status === 'booked');
      expect(bookedSeats).toHaveLength(2);
    });

    it('should reject confirmation for unknown hold', async () => {
      const { status } = await client.confirm('nonexistent-hold-id');
      expect(status).toBe(404);
    });

    it('should reject confirmation for released hold', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');
      await client.release(holdData.holdId);

      const { status } = await client.confirm(holdData.holdId);
      expect(status).toBe(404);
    });
  });

  // ─── DELETE /api/holds/:holdId ────────────────────────────────

  describe('DELETE /api/holds/:holdId', () => {
    it('should release a hold and make seats available again', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id, seatsData.seats[1].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');
      const { status } = await client.release(holdData.holdId);
      expect(status).toBe(200);

      const { data: afterData } = await client.getSeats();
      for (const seatId of seatIds) {
        const seat = afterData.seats.find(s => s.id === seatId);
        expect(seat.status).toBe('available');
      }
    });

    it('should return 404 for unknown hold', async () => {
      const { status } = await client.release('nonexistent-hold-id');
      expect(status).toBe(404);
    });

    it('should return error when trying to release a confirmed hold', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatIds = [seatsData.seats[0].id];

      const { data: holdData } = await client.hold(seatIds, 'session-1');
      await client.confirm(holdData.holdId);

      const { status } = await client.release(holdData.holdId);
      expect(status).toBe(400);
    });
  });

  // ─── Inventory Accounting ─────────────────────────────────────

  describe('Inventory Accounting', () => {
    it('available + held + booked always equals total', async () => {
      const { data: initialData } = await client.getSeats();
      const total = initialData.seats.length;

      // Hold some seats
      const seatIds = initialData.seats.slice(0, 3).map(s => s.id);
      await client.hold(seatIds, 'session-1');

      const { data: afterHold } = await client.getSeats();
      const available1 = afterHold.seats.filter(s => s.status === 'available').length;
      const held1 = afterHold.seats.filter(s => s.status === 'held').length;
      const booked1 = afterHold.seats.filter(s => s.status === 'booked').length;
      expect(available1 + held1 + booked1).toBe(total);
      expect(held1).toBe(3);

      // Confirm the hold
      const { data: holdData } = await client.hold(initialData.seats.slice(3, 5).map(s => s.id), 'session-2');
      await client.confirm(holdData.holdId);

      const { data: afterConfirm } = await client.getSeats();
      const available2 = afterConfirm.seats.filter(s => s.status === 'available').length;
      const held2 = afterConfirm.seats.filter(s => s.status === 'held').length;
      const booked2 = afterConfirm.seats.filter(s => s.status === 'booked').length;
      expect(available2 + held2 + booked2).toBe(total);
      expect(booked2).toBe(2);
      expect(held2).toBe(3);
    });
  });

  // ─── Concurrency ──────────────────────────────────────────────

  describe('Concurrency', () => {
    it('only one of two concurrent holds for the same seat succeeds', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatId = seatsData.seats[0].id;

      // Send two concurrent hold requests for the same seat
      const [r1, r2] = await Promise.all([
        client.hold([seatId], 'session-1'),
        client.hold([seatId], 'session-2'),
      ]);

      // Exactly one should succeed (201) and the other should fail (409)
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([201, 409]);

      // The seat should be held by exactly one session
      const { data: afterData } = await client.getSeats();
      const seat = afterData.seats.find(s => s.id === seatId);
      expect(seat.status).toBe('held');
    });

    it('many concurrent holds for same seat, exactly one wins', async () => {
      const { data: seatsData } = await client.getSeats();
      const seatId = seatsData.seats[0].id;

      // 10 concurrent requests
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          client.hold([seatId], `session-${i}`)
        )
      );

      const successes = results.filter(r => r.status === 201);
      const failures = results.filter(r => r.status === 409);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(9);

      // Verify seat is held exactly once
      const { data: afterData } = await client.getSeats();
      const seat = afterData.seats.find(s => s.id === seatId);
      expect(seat.status).toBe('held');
    });

    it('concurrent holds for different seats all succeed', async () => {
      const { data: seatsData } = await client.getSeats();

      const results = await Promise.all([
        client.hold([seatsData.seats[0].id], 'session-1'),
        client.hold([seatsData.seats[1].id], 'session-2'),
        client.hold([seatsData.seats[2].id], 'session-3'),
      ]);

      for (const r of results) {
        expect(r.status).toBe(201);
      }
    });
  });

  // ─── SSE ──────────────────────────────────────────────────────

  describe('SSE /api/stream', () => {
    it('should establish an SSE connection', async () => {
      const res = await fetch(`${ctx.baseUrl}/api/stream`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/event-stream');
      // Close the connection
      if (res.body) {
        await res.body.cancel();
      }
    });
  });
});
