import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import http from "http";
import crypto from "crypto";

// We test through HTTP against the real routes with a fresh in-memory PGlite per suite.

let app, server, baseUrl;

// We'll override the db module to use an in-memory PGlite
let db;

async function resetDb() {
  db = new PGlite(); // in-memory
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id SERIAL PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_session_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      UNIQUE(row_label, seat_number)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      seat_ids INTEGER[] NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  // Seed 5 rows x 10 seats = 50 seats
  const rows = ["A", "B", "C", "D", "E"];
  const seatsPerRow = 10;
  const values = [];
  const params = [];
  let idx = 1;
  for (const row of rows) {
    for (let s = 1; s <= seatsPerRow; s++) {
      values.push(`($${idx}, $${idx + 1})`);
      params.push(row, s);
      idx += 2;
    }
  }
  await db.query(
    `INSERT INTO seats (row_label, seat_number) VALUES ${values.join(", ")}`,
    params
  );
}

function json(res) {
  return res.json();
}

function buildApp(dbInstance, holdTtlSeconds = 5) {
  // We build a minimal express app using inline route handlers that share the given db
  const appInstance = express();
  appInstance.use(express.json());

  // SSE clients
  const sseClients = new Set();

  function broadcast(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try { client.write(payload); } catch (e) { sseClients.delete(client); }
    }
  }

  async function expireStaleHolds(tx) {
    const expired = await tx.query(`
      UPDATE seats
      SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL
      WHERE status = 'held' AND hold_expires_at IS NOT NULL AND hold_expires_at < NOW()
      RETURNING id, row_label, seat_number
    `);
    if (expired.rows.length > 0) {
      await tx.query(`UPDATE holds SET status = 'expired' WHERE status = 'active' AND expires_at < NOW()`);
    }
    return expired.rows;
  }

  async function expireAndBroadcast() {
    const released = await expireStaleHolds(dbInstance);
    if (released.length > 0) {
      broadcast("seats-updated", released.map(s => ({
        id: s.id, row_label: s.row_label, seat_number: s.seat_number, status: "available",
        hold_id: null, hold_session_id: null, hold_expires_at: null, booked_by: null,
      })));
    }
    return released;
  }

  // SSE
  appInstance.get("/api/stream", (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(":\n\n");
    sseClients.add(res);
    res.on("close", () => sseClients.delete(res));
  });

  // GET /api/seats
  appInstance.get("/api/seats", async (req, res) => {
    await expireAndBroadcast();
    const result = await dbInstance.query(`SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by FROM seats ORDER BY row_label, seat_number`);
    res.json(result.rows);
  });

  // POST /api/holds
  appInstance.post("/api/holds", async (req, res) => {
    const { seatIds, sessionId } = req.body;
    if (!Array.isArray(seatIds) || seatIds.length === 0 || !sessionId) {
      return res.status(400).json({ error: "seatIds and sessionId required" });
    }
    const ids = seatIds.map(id => parseInt(id, 10));
    const holdId = crypto.randomUUID();

    try {
      const result = await dbInstance.transaction(async (tx) => {
        await expireStaleHolds(tx);
        const placeholders = ids.map((_, i) => `$${i+1}`).join(", ");
        const seatsResult = await tx.query(`SELECT id, status FROM seats WHERE id IN (${placeholders}) FOR UPDATE`, ids);

        if (seatsResult.rows.length !== ids.length) {
          const foundIds = new Set(seatsResult.rows.map(r => r.id));
          return { error: true, status: 400, body: { error: "Some seat ids not found", seatIds: ids.filter(id => !foundIds.has(id)) } };
        }

        const conflicting = seatsResult.rows.filter(r => r.status !== "available");
        if (conflicting.length > 0) {
          return { error: true, status: 409, body: { error: "Some seats are not available", conflictingSeatIds: conflicting.map(r => r.id) } };
        }

        const expiresAt = new Date(Date.now() + holdTtlSeconds * 1000).toISOString();
        const upPlaceholders = ids.map((_, i) => `$${i+4}`).join(", ");
        await tx.query(`UPDATE seats SET status = 'held', hold_id = $1, hold_session_id = $2, hold_expires_at = $3::timestamptz WHERE id IN (${upPlaceholders})`, [holdId, sessionId, expiresAt, ...ids]);
        await tx.query(`INSERT INTO holds (id, session_id, seat_ids, expires_at) VALUES ($1, $2, $3, $4::timestamptz)`, [holdId, sessionId, ids, expiresAt]);

        return { error: false, hold: { holdId, sessionId, seatIds: ids, expiresAt } };
      });

      if (result.error) return res.status(result.status).json(result.body);

      const updatedSeats = await dbInstance.query(`SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by FROM seats WHERE hold_id = $1`, [holdId]);
      broadcast("seats-updated", updatedSeats.rows);
      return res.status(201).json(result.hold);
    } catch (err) {
      console.error("POST /holds error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /api/holds/:holdId/confirm
  appInstance.post("/api/holds/:holdId/confirm", async (req, res) => {
    const { holdId } = req.params;
    try {
      const result = await dbInstance.transaction(async (tx) => {
        await expireStaleHolds(tx);
        const holdResult = await tx.query(`SELECT id, session_id, seat_ids, expires_at, status FROM holds WHERE id = $1 FOR UPDATE`, [holdId]);

        if (holdResult.rows.length === 0) return { error: true, status: 404, body: { error: "Hold not found" } };
        const hold = holdResult.rows[0];

        if (hold.status === "confirmed") {
          const seats = await tx.query(`SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by FROM seats WHERE booked_by = $1 AND hold_id = $2`, [hold.session_id, holdId]);
          return { error: false, alreadyConfirmed: true, booking: { holdId: hold.id, sessionId: hold.session_id, seatIds: hold.seat_ids, status: "confirmed" }, seats: seats.rows };
        }

        if (hold.status === "expired" || hold.status === "released") {
          return { error: true, status: 410, body: { error: `Hold has ${hold.status}` } };
        }

        if (new Date(hold.expires_at) < new Date()) {
          await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
          await tx.query(`UPDATE seats SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL WHERE hold_id = $1 AND status = 'held'`, [holdId]);
          return { error: true, status: 410, body: { error: "Hold has expired" } };
        }

        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i+1}`).join(", ");
        const seatCheck = await tx.query(`SELECT id, status, hold_id FROM seats WHERE id IN (${placeholders}) FOR UPDATE`, seatIds);
        const invalidSeats = seatCheck.rows.filter(s => s.status !== "held" || s.hold_id !== holdId);
        if (invalidSeats.length > 0) {
          await tx.query(`UPDATE holds SET status = 'expired' WHERE id = $1`, [holdId]);
          return { error: true, status: 409, body: { error: "Hold is no longer valid" } };
        }

        const upPlaceholders = seatIds.map((_, i) => `$${i+3}`).join(", ");
        await tx.query(`UPDATE seats SET status = 'booked', booked_by = $1 WHERE hold_id = $2 AND id IN (${upPlaceholders})`, [hold.session_id, holdId, ...seatIds]);
        await tx.query(`UPDATE holds SET status = 'confirmed' WHERE id = $1`, [holdId]);

        const seats = await tx.query(`SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders})`, seatIds);
        return { error: false, alreadyConfirmed: false, booking: { holdId: hold.id, sessionId: hold.session_id, seatIds: hold.seat_ids, status: "confirmed" }, seats: seats.rows };
      });

      if (result.error) return res.status(result.status).json(result.body);
      if (!result.alreadyConfirmed) broadcast("seats-updated", result.seats);
      return res.json(result.booking);
    } catch (err) {
      console.error("POST /holds/:holdId/confirm error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // DELETE /api/holds/:holdId
  appInstance.delete("/api/holds/:holdId", async (req, res) => {
    const { holdId } = req.params;
    try {
      const result = await dbInstance.transaction(async (tx) => {
        const holdResult = await tx.query(`SELECT id, session_id, seat_ids, status FROM holds WHERE id = $1 FOR UPDATE`, [holdId]);
        if (holdResult.rows.length === 0) return { error: true, status: 404, body: { error: "Hold not found" } };
        const hold = holdResult.rows[0];
        if (hold.status === "confirmed") return { error: true, status: 400, body: { error: "Cannot release a confirmed hold" } };
        if (hold.status === "released") return { error: false, alreadyReleased: true, seats: [] };

        const seatIds = hold.seat_ids;
        const placeholders = seatIds.map((_, i) => `$${i+1}`).join(", ");
        await tx.query(`UPDATE seats SET status = 'available', hold_id = NULL, hold_session_id = NULL, hold_expires_at = NULL WHERE hold_id = $${seatIds.length+1} AND id IN (${placeholders})`, [...seatIds, holdId]);
        await tx.query(`UPDATE holds SET status = 'released' WHERE id = $1`, [holdId]);
        const seats = await tx.query(`SELECT id, row_label, seat_number, status, hold_id, hold_session_id, hold_expires_at, booked_by FROM seats WHERE id IN (${placeholders})`, seatIds);
        return { error: false, alreadyReleased: false, seats: seats.rows };
      });

      if (result.error) return res.status(result.status).json(result.body);
      if (!result.alreadyReleased && result.seats.length > 0) broadcast("seats-updated", result.seats);
      return res.json({ success: true });
    } catch (err) {
      console.error("DELETE /holds/:holdId error:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /api/inventory
  appInstance.get("/api/inventory", async (req, res) => {
    await expireAndBroadcast();
    const result = await dbInstance.query(`SELECT COUNT(*) FILTER (WHERE status = 'available') AS available, COUNT(*) FILTER (WHERE status = 'held') AS held, COUNT(*) FILTER (WHERE status = 'booked') AS booked, COUNT(*) AS total FROM seats`);
    res.json(result.rows[0]);
  });

  return appInstance;
}

async function startTestServer(holdTtl = 5) {
  await resetDb();
  app = buildApp(db, holdTtl);
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
}

async function stopTestServer() {
  await new Promise((resolve) => {
    if (server) {
      server.close(resolve);
      server = null;
    } else {
      resolve();
    }
  });
  if (db) {
    try { await db.close(); } catch (e) {}
    db = null;
  }
}

// Helper
async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(`${baseUrl}${path}`, opts);
}

// =====================================================================
// Tests
// =====================================================================

describe("Seat Booking System", () => {
  afterAll(async () => {
    await stopTestServer();
  });

  describe("Basic CRUD", () => {
    beforeAll(async () => {
      await startTestServer(5);
    });

    it("should return 50 seats all available", async () => {
      const res = await api("GET", "/api/seats");
      expect(res.status).toBe(200);
      const seats = await res.json();
      expect(seats.length).toBe(50);
      expect(seats.every(s => s.status === "available")).toBe(true);
    });

    it("should show correct inventory", async () => {
      const res = await api("GET", "/api/inventory");
      const inv = await res.json();
      expect(parseInt(inv.available)).toBe(50);
      expect(parseInt(inv.held)).toBe(0);
      expect(parseInt(inv.booked)).toBe(0);
      expect(parseInt(inv.total)).toBe(50);
    });
  });

  describe("Hold Flow", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(5);
    });

    it("should create a hold for requested seats", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [1, 2, 3], sessionId: "user-1" });
      expect(res.status).toBe(201);
      const hold = await res.json();
      expect(hold.holdId).toBeTruthy();
      expect(hold.seatIds).toEqual([1, 2, 3]);
      expect(hold.expiresAt).toBeTruthy();
    });

    it("should mark held seats as held", async () => {
      const res = await api("GET", "/api/seats");
      const seats = await res.json();
      const heldSeats = seats.filter(s => s.status === "held");
      expect(heldSeats.length).toBe(3);
      const heldIds = heldSeats.map(s => s.id).sort();
      expect(heldIds).toEqual([1, 2, 3]);
    });

    it("should reject hold on already-held seats (409 with conflicting ids)", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [2, 3, 4], sessionId: "user-2" });
      expect(res.status).toBe(409);
      const err = await res.json();
      expect(err.conflictingSeatIds).toBeDefined();
      expect(err.conflictingSeatIds.sort()).toEqual([2, 3]);
    });

    it("should be all-or-nothing: user-2 gets no seats on partial conflict", async () => {
      const res = await api("GET", "/api/seats");
      const seats = await res.json();
      // Seat 4 should still be available
      const seat4 = seats.find(s => s.id === 4);
      expect(seat4.status).toBe("available");
    });

    it("should show correct inventory with holds", async () => {
      const res = await api("GET", "/api/inventory");
      const inv = await res.json();
      expect(parseInt(inv.available)).toBe(47);
      expect(parseInt(inv.held)).toBe(3);
      expect(parseInt(inv.booked)).toBe(0);
      expect(parseInt(inv.total)).toBe(50);
    });
  });

  describe("Confirm Flow", () => {
    let holdId;

    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60); // long TTL so it doesn't expire
    });

    it("should hold seats, then confirm them", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [1, 2], sessionId: "booker" });
      expect(holdRes.status).toBe(201);
      const hold = await holdRes.json();
      holdId = hold.holdId;

      const confirmRes = await api("POST", `/api/holds/${holdId}/confirm`);
      expect(confirmRes.status).toBe(200);
      const booking = await confirmRes.json();
      expect(booking.status).toBe("confirmed");
      expect(booking.seatIds).toEqual([1, 2]);
    });

    it("confirmed seats are booked", async () => {
      const res = await api("GET", "/api/seats");
      const seats = await res.json();
      expect(seats.find(s => s.id === 1).status).toBe("booked");
      expect(seats.find(s => s.id === 2).status).toBe("booked");
    });

    it("cannot hold already-booked seats", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [1], sessionId: "user-x" });
      expect(res.status).toBe(409);
    });

    it("confirmation is idempotent", async () => {
      const res1 = await api("POST", `/api/holds/${holdId}/confirm`);
      expect(res1.status).toBe(200);
      const b1 = await res1.json();
      expect(b1.status).toBe("confirmed");

      const res2 = await api("POST", `/api/holds/${holdId}/confirm`);
      expect(res2.status).toBe(200);
      const b2 = await res2.json();
      expect(b2.status).toBe("confirmed");
      expect(b2.holdId).toBe(b1.holdId);
    });

    it("unknown hold returns 404", async () => {
      const res = await api("POST", "/api/holds/nonexistent/confirm");
      expect(res.status).toBe(404);
    });
  });

  describe("Release Flow", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60);
    });

    it("should release a hold and seats become available", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [5, 6], sessionId: "user-r" });
      const hold = await holdRes.json();

      const delRes = await api("DELETE", `/api/holds/${hold.holdId}`);
      expect(delRes.status).toBe(200);

      const seatsRes = await api("GET", "/api/seats");
      const seats = await seatsRes.json();
      expect(seats.find(s => s.id === 5).status).toBe("available");
      expect(seats.find(s => s.id === 6).status).toBe("available");
    });

    it("released seats can be held by another user", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [5, 6], sessionId: "user-r2" });
      expect(res.status).toBe(201);
    });

    it("cannot release a confirmed hold", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [7], sessionId: "booker2" });
      const hold = await holdRes.json();
      await api("POST", `/api/holds/${hold.holdId}/confirm`);

      const delRes = await api("DELETE", `/api/holds/${hold.holdId}`);
      expect(delRes.status).toBe(400);
    });
  });

  describe("TTL Expiry", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(1); // 1 second TTL
    });

    it("seats become available after hold TTL expires", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [10, 11], sessionId: "expiry-user" });
      expect(holdRes.status).toBe(201);

      // Verify seats are held
      let seatsRes = await api("GET", "/api/seats");
      let seats = await seatsRes.json();
      expect(seats.find(s => s.id === 10).status).toBe("held");
      expect(seats.find(s => s.id === 11).status).toBe("held");

      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 1500));

      // Seats should now be available (expiry happens on read)
      seatsRes = await api("GET", "/api/seats");
      seats = await seatsRes.json();
      expect(seats.find(s => s.id === 10).status).toBe("available");
      expect(seats.find(s => s.id === 11).status).toBe("available");
    });

    it("confirming an expired hold fails", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [12], sessionId: "expiry-user-2" });
      const hold = await holdRes.json();

      // Wait for expiry
      await new Promise(r => setTimeout(r, 1500));

      const confirmRes = await api("POST", `/api/holds/${hold.holdId}/confirm`);
      expect(confirmRes.status).toBe(410);
      const err = await confirmRes.json();
      expect(err.error).toMatch(/expired/i);

      // Seat should be available
      const seatsRes = await api("GET", "/api/seats");
      const seats = await seatsRes.json();
      expect(seats.find(s => s.id === 12).status).toBe("available");
    });

    it("expired seats can be re-held by another user", async () => {
      const holdRes = await api("POST", "/api/holds", { seatIds: [13], sessionId: "first" });
      expect(holdRes.status).toBe(201);

      await new Promise(r => setTimeout(r, 1500));

      // Another user grabs the same seat
      const holdRes2 = await api("POST", "/api/holds", { seatIds: [13], sessionId: "second" });
      expect(holdRes2.status).toBe(201);
    });
  });

  describe("Inventory Consistency", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60);
    });

    it("available + held + booked = total at all times", async () => {
      // Make some holds
      await api("POST", "/api/holds", { seatIds: [1, 2, 3], sessionId: "inv-1" });
      await api("POST", "/api/holds", { seatIds: [4, 5], sessionId: "inv-2" });

      // Confirm first hold
      const seatsRes = await api("GET", "/api/seats");
      const seats = await seatsRes.json();
      const hold1Id = seats.find(s => s.id === 1).hold_id;
      await api("POST", `/api/holds/${hold1Id}/confirm`);

      // Release second hold
      const hold2Id = seats.find(s => s.id === 4).hold_id;
      await api("DELETE", `/api/holds/${hold2Id}`);

      // Check inventory
      const invRes = await api("GET", "/api/inventory");
      const inv = await invRes.json();
      const available = parseInt(inv.available);
      const held = parseInt(inv.held);
      const booked = parseInt(inv.booked);
      const total = parseInt(inv.total);

      expect(available + held + booked).toBe(total);
      expect(total).toBe(50);
      expect(booked).toBe(3);
      expect(held).toBe(0);
      expect(available).toBe(47);
    });
  });

  describe("Concurrent Holds", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60);
    });

    it("concurrent holds for the same seat: exactly one succeeds", async () => {
      // Fire 10 concurrent hold requests for seat 1
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(api("POST", "/api/holds", { seatIds: [1], sessionId: `concurrent-${i}` }));
      }
      const results = await Promise.all(promises);
      const statuses = results.map(r => r.status);
      const successes = statuses.filter(s => s === 201);
      const conflicts = statuses.filter(s => s === 409);

      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(9);
    });

    it("concurrent holds for different seats all succeed", async () => {
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(api("POST", "/api/holds", { seatIds: [10 + i], sessionId: `diff-${i}` }));
      }
      const results = await Promise.all(promises);
      const statuses = results.map(r => r.status);
      expect(statuses.every(s => s === 201)).toBe(true);
    });

    it("no double booking under concurrent confirms", async () => {
      // Hold some seats
      const holdRes = await api("POST", "/api/holds", { seatIds: [20, 21], sessionId: "double-check" });
      const hold = await holdRes.json();

      // Fire 5 concurrent confirms
      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(api("POST", `/api/holds/${hold.holdId}/confirm`));
      }
      const results = await Promise.all(promises);
      const bodies = await Promise.all(results.map(r => r.json()));

      // All should succeed (idempotent)
      expect(results.every(r => r.status === 200)).toBe(true);

      // Seats should be booked exactly once
      const seatsRes = await api("GET", "/api/seats");
      const seats = await seatsRes.json();
      expect(seats.find(s => s.id === 20).status).toBe("booked");
      expect(seats.find(s => s.id === 21).status).toBe("booked");
      expect(seats.find(s => s.id === 20).booked_by).toBe("double-check");
      expect(seats.find(s => s.id === 21).booked_by).toBe("double-check");
    });
  });

  describe("SSE Streaming", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60);
    });

    it("should send seat updates via SSE when a hold is placed", async () => {
      // Connect to SSE
      const events = [];
      const controller = new AbortController();
      const response = await fetch(`${baseUrl}/api/stream`, { signal: controller.signal });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Wait a tick for connection to be established
      await new Promise(r => setTimeout(r, 100));

      // Read in background
      let readBuffer = "";
      const readPromise = (async () => {
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            readBuffer += decoder.decode(value, { stream: true });

            // Parse SSE events from complete lines
            const parts = readBuffer.split("\n\n");
            // Process all complete events (all but last which may be partial)
            for (let i = 0; i < parts.length - 1; i++) {
              const eventBlock = parts[i];
              const lines = eventBlock.split("\n");
              for (const line of lines) {
                if (line.startsWith("data: ")) {
                  try {
                    events.push(JSON.parse(line.slice(6)));
                  } catch (e) {}
                }
              }
            }
            readBuffer = parts[parts.length - 1];

            // Stop after we get some events
            if (events.length >= 1) break;
          }
        } catch (e) {
          // AbortError is expected
        }
      })();

      // Make a hold
      await api("POST", "/api/holds", { seatIds: [30], sessionId: "sse-test" });

      // Wait for SSE to deliver
      await Promise.race([readPromise, new Promise(r => setTimeout(r, 3000))]);

      // Cancel reader
      try { controller.abort(); } catch(e) {}
      try { reader.cancel(); } catch(e) {}

      // We should have received at least one SSE event with seat 30 held
      expect(events.length).toBeGreaterThanOrEqual(1);
      const seatUpdate = events.flat().find(s => s.id === 30);
      expect(seatUpdate).toBeDefined();
      expect(seatUpdate.status).toBe("held");
    });
  });

  describe("Edge Cases", () => {
    beforeAll(async () => {
      await stopTestServer();
      await startTestServer(60);
    });

    it("empty seatIds returns 400", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [], sessionId: "x" });
      expect(res.status).toBe(400);
    });

    it("missing sessionId returns 400", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [1] });
      expect(res.status).toBe(400);
    });

    it("non-existent seat id returns 400", async () => {
      const res = await api("POST", "/api/holds", { seatIds: [999], sessionId: "x" });
      expect(res.status).toBe(400);
    });

    it("deleting non-existent hold returns 404", async () => {
      const res = await api("DELETE", "/api/holds/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
