import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  setupTestServer,
  teardownTestServer,
  resetDatabase,
  getBaseUrl,
} from "./setup.js";

let baseUrl;

beforeAll(async () => {
  const result = await setupTestServer();
  baseUrl = result.baseUrl;
});

afterAll(async () => {
  await teardownTestServer();
});

beforeEach(async () => {
  await resetDatabase();
});

function api(path, options = {}) {
  return fetch(`${baseUrl}/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
}

describe("GET /api/seats", () => {
  it("returns all 50 seats", async () => {
    const res = await api("/seats");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.seats).toHaveLength(50);
    expect(data.seats.every((s) => s.status === "available")).toBe(true);
  });

  it("returns seats with correct structure", async () => {
    const res = await api("/seats");
    const data = await res.json();
    const seat = data.seats[0];
    expect(seat).toHaveProperty("id");
    expect(seat).toHaveProperty("rowLabel");
    expect(seat).toHaveProperty("seatNumber");
    expect(seat).toHaveProperty("status");
  });
});

describe("POST /api/holds", () => {
  it("creates a hold for available seats", async () => {
    const res = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2, 3], sessionId: "session-1" }),
    });
    expect(res.status).toBe(201);
    const hold = await res.json();
    expect(hold.holdId).toBeDefined();
    expect(hold.seatIds).toEqual([1, 2, 3]);
    expect(hold.expiresAt).toBeDefined();
    expect(hold.sessionId).toBe("session-1");
  });

  it("marks held seats as held in the seat map", async () => {
    await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });

    const res = await api("/seats");
    const data = await res.json();
    const held = data.seats.filter((s) => s.status === "held");
    expect(held).toHaveLength(2);
    expect(held.map((s) => s.id).sort()).toEqual([1, 2]);
  });

  it("returns 409 when any requested seat is unavailable (all-or-nothing)", async () => {
    // Hold seats 1, 2
    await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });

    // Try to hold seats 2, 3 (seat 2 is held)
    const res = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [2, 3], sessionId: "session-2" }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.conflictingSeatIds).toContain(2);

    // Verify seat 3 is NOT held (all-or-nothing)
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const seat3 = seatsData.seats.find((s) => s.id === 3);
    expect(seat3.status).toBe("available");
  });

  it("rejects empty seatIds", async () => {
    const res = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [], sessionId: "session-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing sessionId", async () => {
    const res = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1] }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/holds/:holdId/confirm", () => {
  it("confirms an active hold and books the seats", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    const confirmRes = await api(`/holds/${hold.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirmRes.status).toBe(200);
    const booking = await confirmRes.json();
    expect(booking.status).toBe("confirmed");
    expect(booking.seatIds).toEqual([1, 2]);

    // Verify seats are booked
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const booked = seatsData.seats.filter((s) => s.status === "booked");
    expect(booked).toHaveLength(2);
  });

  it("is idempotent - second confirm returns same result", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    // Confirm twice
    const confirm1 = await api(`/holds/${hold.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirm1.status).toBe(200);
    const booking1 = await confirm1.json();

    const confirm2 = await api(`/holds/${hold.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirm2.status).toBe(200);
    const booking2 = await confirm2.json();

    expect(booking1.holdId).toBe(booking2.holdId);
    expect(booking1.seatIds).toEqual(booking2.seatIds);

    // Verify only 2 seats booked (not 4)
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const booked = seatsData.seats.filter((s) => s.status === "booked");
    expect(booked).toHaveLength(2);
  });

  it("rejects confirmation of unknown hold", async () => {
    const res = await api("/holds/unknown-id/confirm", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("rejects confirmation of expired hold", async () => {
    // Create a hold with very short TTL by manipulating the DB directly
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    // Manually expire the hold
    const { getDb } = await import("../backend/db.js");
    const db = await getDb();
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [hold.holdId]
    );

    const confirmRes = await api(`/holds/${hold.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirmRes.status).toBe(410);

    // Verify no seats booked
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const booked = seatsData.seats.filter((s) => s.status === "booked");
    expect(booked).toHaveLength(0);
  });
});

describe("DELETE /api/holds/:holdId", () => {
  it("releases a hold and makes seats available", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    const delRes = await api(`/holds/${hold.holdId}`, { method: "DELETE" });
    expect(delRes.status).toBe(200);

    // Verify seats are available
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const available = seatsData.seats.filter((s) => s.status === "available");
    expect(available).toHaveLength(50);
  });

  it("returns 404 for unknown hold", async () => {
    const res = await api("/holds/unknown-id", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when trying to release a confirmed hold", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    await api(`/holds/${hold.holdId}/confirm`, { method: "POST" });

    const delRes = await api(`/holds/${hold.holdId}`, { method: "DELETE" });
    expect(delRes.status).toBe(400);
  });
});

describe("Auto-expiry", () => {
  it("expired holds make seats available on GET /seats", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    // Manually expire the hold
    const { getDb } = await import("../backend/db.js");
    const db = await getDb();
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [hold.holdId]
    );

    // Fetch seats - should show as available
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const available = seatsData.seats.filter((s) => s.status === "available");
    expect(available).toHaveLength(50);
  });

  it("expired seats can be re-held by another user", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    // Manually expire
    const { getDb } = await import("../backend/db.js");
    const db = await getDb();
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [hold.holdId]
    );

    // Another user can now hold seat 1
    const holdRes2 = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-2" }),
    });
    expect(holdRes2.status).toBe(201);
    const hold2 = await holdRes2.json();
    expect(hold2.sessionId).toBe("session-2");
  });
});

describe("Inventory consistency", () => {
  it("available + held + booked = total at all times", async () => {
    // Initial state
    let invRes = await api("/inventory");
    let inv = await invRes.json();
    expect(inv.available + inv.held + inv.booked).toBe(50);
    expect(inv.total).toBe(50);

    // After hold
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2, 3], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    invRes = await api("/inventory");
    inv = await invRes.json();
    expect(inv.available).toBe(47);
    expect(inv.held).toBe(3);
    expect(inv.booked).toBe(0);
    expect(inv.total).toBe(50);

    // After confirm
    await api(`/holds/${hold.holdId}/confirm`, { method: "POST" });

    invRes = await api("/inventory");
    inv = await invRes.json();
    expect(inv.available).toBe(47);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(3);
    expect(inv.total).toBe(50);
  });

  it("inventory is exact after hold + release", async () => {
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1, 2], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();

    await api(`/holds/${hold.holdId}`, { method: "DELETE" });

    const invRes = await api("/inventory");
    const inv = await invRes.json();
    expect(inv.available).toBe(50);
    expect(inv.held).toBe(0);
    expect(inv.booked).toBe(0);
    expect(inv.total).toBe(50);
  });
});

describe("Concurrent hold requests", () => {
  it("only one of two concurrent requests for the same seat succeeds", async () => {
    // Fire two hold requests for the same seat concurrently
    const [res1, res2] = await Promise.all([
      api("/holds", {
        method: "POST",
        body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
      }),
      api("/holds", {
        method: "POST",
        body: JSON.stringify({ seatIds: [1], sessionId: "session-2" }),
      }),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual([201, 409]);

    // Verify only one hold exists
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const held = seatsData.seats.filter((s) => s.status === "held");
    expect(held).toHaveLength(1);
  });

  it("no seat is ever booked by two different sessions", async () => {
    // Create 10 concurrent hold requests for the same 5 seats
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        api("/holds", {
          method: "POST",
          body: JSON.stringify({
            seatIds: [1, 2, 3, 4, 5],
            sessionId: `session-${i}`,
          }),
        })
      );
    }

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.status === 201);
    const conflicts = results.filter((r) => r.status === 409);

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    // Confirm the winning hold
    const holdData = await successes[0].json();
    const confirmRes = await api(`/holds/${holdData.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirmRes.status).toBe(200);

    // Verify inventory
    const invRes = await api("/inventory");
    const inv = await invRes.json();
    expect(inv.booked).toBe(5);
    expect(inv.total).toBe(50);
  });
});

describe("SSE endpoint", () => {
  it("establishes a connection", async () => {
    const res = await fetch(`${baseUrl}/api/stream`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    // Clean up by closing the body
    if (res.body) {
      const reader = res.body.getReader();
      reader.cancel();
    }
  });
});

describe("Edge cases", () => {
  it("cannot hold a booked seat", async () => {
    // Hold and confirm seat 1
    const holdRes = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
    });
    const hold = await holdRes.json();
    await api(`/holds/${hold.holdId}/confirm`, { method: "POST" });

    // Try to hold seat 1 again
    const holdRes2 = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-2" }),
    });
    expect(holdRes2.status).toBe(409);
  });

  it("confirming after expiry doesn't book seats another user now holds", async () => {
    // Session 1 holds seat 1
    const holdRes1 = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-1" }),
    });
    const hold1 = await holdRes1.json();

    // Expire session 1's hold
    const { getDb } = await import("../backend/db.js");
    const db = await getDb();
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold1.holdId]
    );
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [hold1.holdId]
    );

    // Session 2 holds seat 1
    const holdRes2 = await api("/holds", {
      method: "POST",
      body: JSON.stringify({ seatIds: [1], sessionId: "session-2" }),
    });
    expect(holdRes2.status).toBe(201);

    // Session 1 tries to confirm - should fail
    const confirmRes = await api(`/holds/${hold1.holdId}/confirm`, {
      method: "POST",
    });
    expect(confirmRes.status).toBe(410);

    // Verify seat 1 is still held by session 2, not booked by session 1
    const seatsRes = await api("/seats");
    const seatsData = await seatsRes.json();
    const seat1 = seatsData.seats.find((s) => s.id === 1);
    expect(seat1.status).toBe("held");
    expect(seat1.sessionId).toBe("session-2");
  });
});
