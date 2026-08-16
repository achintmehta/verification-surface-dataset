/**
 * Seat-booking integration tests.
 *
 * Each test suite gets a fresh in-memory PGLite database so tests are
 * fully isolated and can run in parallel (--runInBand keeps them serial
 * to avoid PGLite file-lock issues, but isolation is still guaranteed).
 */

import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import express from "express";
import cors from "cors";

// We import the route factories and db helpers directly so we can inject
// a fresh in-memory db for every test file.
import { initDb, setDb } from "../backend/db.js";
import seatsRouter from "../backend/routes/seats.js";
import holdsRouter from "../backend/routes/holds.js";
import streamRouter from "../backend/routes/stream.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createTestApp() {
  const db = new PGlite(); // in-memory
  await db.waitReady;
  setDb(db);
  await initDb(db);

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api/seats", seatsRouter);
  app.use("/api/holds", holdsRouter);
  app.use("/api/stream", streamRouter);

  return { app, db };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /api/seats", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it("returns all 50 seats", async () => {
    const res = await request(app).get("/api/seats");
    expect(res.status).toBe(200);
    expect(res.body.seats).toHaveLength(50);
  });

  it("all seats start as available", async () => {
    const res = await request(app).get("/api/seats");
    const statuses = res.body.seats.map((s) => s.status);
    expect(statuses.every((s) => s === "available")).toBe(true);
  });

  it("returns correct seat structure", async () => {
    const res = await request(app).get("/api/seats");
    const seat = res.body.seats[0];
    expect(seat).toHaveProperty("id");
    expect(seat).toHaveProperty("row_label");
    expect(seat).toHaveProperty("seat_number");
    expect(seat).toHaveProperty("status");
  });
});

describe("POST /api/holds – basic hold creation", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it("creates a hold for available seats", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A1", "A2"], sessionId: "session-1" });

    expect(res.status).toBe(201);
    expect(res.body.hold).toMatchObject({
      seat_ids: expect.arrayContaining(["A1", "A2"]),
      session_id: "session-1",
    });
    expect(res.body.hold.id).toBeTruthy();
    expect(res.body.hold.expires_at).toBeTruthy();
  });

  it("marks held seats as held in the seat map", async () => {
    const res = await request(app).get("/api/seats");
    const a1 = res.body.seats.find((s) => s.id === "A1");
    const a2 = res.body.seats.find((s) => s.id === "A2");
    expect(a1.status).toBe("held");
    expect(a2.status).toBe("held");
  });

  it("returns 400 for missing seatIds", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ sessionId: "session-1" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing sessionId", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A3"] });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty seatIds array", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: [], sessionId: "session-1" });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/holds – conflict detection (all-or-nothing)", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    // Pre-hold B1
    await request(app)
      .post("/api/holds")
      .send({ seatIds: ["B1"], sessionId: "session-owner" });
  });

  it("returns 409 when requesting an already-held seat", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["B1"], sessionId: "session-other" });

    expect(res.status).toBe(409);
    expect(res.body.conflicting).toContain("B1");
  });

  it("returns 409 and acquires NONE when one of multiple seats is held (all-or-nothing)", async () => {
    // B2 is available, B1 is held
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["B1", "B2"], sessionId: "session-other" });

    expect(res.status).toBe(409);
    expect(res.body.conflicting).toContain("B1");

    // B2 must still be available
    const seatsRes = await request(app).get("/api/seats");
    const b2 = seatsRes.body.seats.find((s) => s.id === "B2");
    expect(b2.status).toBe("available");
  });

  it("returns 409 for a booked seat", async () => {
    // Book C1 first
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C1"], sessionId: "session-booker" });
    const holdId = holdRes.body.hold.id;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: "session-booker" });

    // Now try to hold C1 again
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C1"], sessionId: "session-other" });

    expect(res.status).toBe(409);
    expect(res.body.conflicting).toContain("C1");
  });
});

describe("POST /api/holds/:holdId/confirm", () => {
  let app;
  let holdId;
  const SESSION = "session-confirm";

  beforeAll(async () => {
    ({ app } = await createTestApp());
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["D1", "D2"], sessionId: SESSION });
    holdId = res.body.hold.id;
  });

  it("confirms an active hold and books the seats", async () => {
    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: SESSION });

    expect(res.status).toBe(200);
    expect(res.body.booking.hold_id).toBe(holdId);
    expect(res.body.booking.seats).toHaveLength(2);
  });

  it("seats are now booked in the seat map", async () => {
    const res = await request(app).get("/api/seats");
    const d1 = res.body.seats.find((s) => s.id === "D1");
    const d2 = res.body.seats.find((s) => s.id === "D2");
    expect(d1.status).toBe("booked");
    expect(d2.status).toBe("booked");
  });

  it("is idempotent – second confirm returns same booking, status 200", async () => {
    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: SESSION });

    expect(res.status).toBe(200);
    // Still only 2 seats booked (not doubled)
    const seatsRes = await request(app).get("/api/seats");
    const booked = seatsRes.body.seats.filter((s) => s.status === "booked");
    // D1 and D2 are booked; no duplicates
    expect(booked.filter((s) => s.id === "D1")).toHaveLength(1);
    expect(booked.filter((s) => s.id === "D2")).toHaveLength(1);
  });

  it("returns 404 for unknown hold id", async () => {
    const res = await request(app)
      .post("/api/holds/nonexistent-hold-id/confirm")
      .send({ sessionId: SESSION });
    expect(res.status).toBe(404);
  });

  it("returns 403 for wrong session", async () => {
    // Create a new hold
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["E1"], sessionId: "owner-session" });
    const hId = holdRes.body.hold.id;

    const res = await request(app)
      .post(`/api/holds/${hId}/confirm`)
      .send({ sessionId: "wrong-session" });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/holds/:holdId – early release", () => {
  let app;
  let holdId;
  const SESSION = "session-release";

  beforeAll(async () => {
    ({ app } = await createTestApp());
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A5", "A6"], sessionId: SESSION });
    holdId = res.body.hold.id;
  });

  it("releases the hold and returns seats to available", async () => {
    const res = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: SESSION });

    expect(res.status).toBe(200);
    expect(res.body.released).toEqual(expect.arrayContaining(["A5", "A6"]));
  });

  it("seats are available again after release", async () => {
    const res = await request(app).get("/api/seats");
    const a5 = res.body.seats.find((s) => s.id === "A5");
    const a6 = res.body.seats.find((s) => s.id === "A6");
    expect(a5.status).toBe("available");
    expect(a6.status).toBe("available");
  });

  it("released seats can be held again", async () => {
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A5"], sessionId: "session-new" });
    expect(res.status).toBe(201);
  });

  it("returns 404 for unknown hold", async () => {
    const res = await request(app)
      .delete("/api/holds/no-such-hold")
      .send({ sessionId: SESSION });
    expect(res.status).toBe(404);
  });

  it("returns 403 for wrong session", async () => {
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["B5"], sessionId: "owner" });
    const hId = holdRes.body.hold.id;

    const res = await request(app)
      .delete(`/api/holds/${hId}`)
      .send({ sessionId: "not-owner" });

    expect(res.status).toBe(403);
  });
});

describe("Hold expiry", () => {
  let app, db;

  beforeAll(async () => {
    ({ app, db } = await createTestApp());
  });

  it("expired holds are reported as available in GET /api/seats", async () => {
    // Create a hold
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C5"], sessionId: "session-expiry" });
    const holdId = holdRes.body.hold.id;

    // Manually expire the hold in the DB
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [holdId]
    );
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdId]
    );

    // GET /api/seats triggers lazy expiry
    const res = await request(app).get("/api/seats");
    const c5 = res.body.seats.find((s) => s.id === "C5");
    expect(c5.status).toBe("available");
  });

  it("confirming an expired hold returns 410", async () => {
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C6"], sessionId: "session-expiry2" });
    const holdId = holdRes.body.hold.id;

    // Expire it
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [holdId]
    );

    const res = await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: "session-expiry2" });

    expect(res.status).toBe(410);
  });

  it("expired hold's seats can be held by another session", async () => {
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C7"], sessionId: "session-expiry3" });
    const holdId = holdRes.body.hold.id;

    // Expire it
    await db.query(
      `UPDATE holds SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`,
      [holdId]
    );
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [holdId]
    );

    // Another session can now hold C7
    const res = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["C7"], sessionId: "session-new-holder" });

    expect(res.status).toBe(201);
  });
});

describe("Inventory accounting", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it("available + held + booked always equals 50", async () => {
    // Hold some seats
    await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A1", "A2", "A3"], sessionId: "s1" });

    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["B1", "B2"], sessionId: "s2" });
    const holdId = holdRes.body.hold.id;

    // Confirm one hold
    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: "s2" });

    const res = await request(app).get("/api/seats");
    const seats = res.body.seats;

    const available = seats.filter((s) => s.status === "available").length;
    const held = seats.filter((s) => s.status === "held").length;
    const booked = seats.filter((s) => s.status === "booked").length;

    expect(available + held + booked).toBe(50);
    expect(booked).toBe(2);
    expect(held).toBe(3);
    expect(available).toBe(45);
  });
});

describe("Concurrency – no double-booking", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it("only one of two concurrent hold requests for the same seat succeeds", async () => {
    // Fire two simultaneous hold requests for the same seat
    const [res1, res2] = await Promise.all([
      request(app)
        .post("/api/holds")
        .send({ seatIds: ["E10"], sessionId: "concurrent-1" }),
      request(app)
        .post("/api/holds")
        .send({ seatIds: ["E10"], sessionId: "concurrent-2" }),
    ]);

    const statuses = [res1.status, res2.status];
    expect(statuses).toContain(201);
    expect(statuses).toContain(409);
  });

  it("seat is held exactly once after concurrent requests", async () => {
    const res = await request(app).get("/api/seats");
    const e10 = res.body.seats.find((s) => s.id === "E10");
    expect(e10.status).toBe("held");
  });

  it("no seat is booked by two different sessions", async () => {
    // Hold and confirm D5 for session A
    const h1 = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["D5"], sessionId: "session-A" });
    const holdId = h1.body.hold.id;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: "session-A" });

    // Try to hold D5 for session B
    const h2 = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["D5"], sessionId: "session-B" });

    expect(h2.status).toBe(409);

    // Verify only one booking
    const seatsRes = await request(app).get("/api/seats");
    const d5 = seatsRes.body.seats.find((s) => s.id === "D5");
    expect(d5.status).toBe("booked");
    expect(d5.booked_by).toBeTruthy();
  });
});

describe("Cannot release a confirmed hold", () => {
  let app;

  beforeAll(async () => {
    ({ app } = await createTestApp());
  });

  it("returns 409 when trying to delete a confirmed hold", async () => {
    const holdRes = await request(app)
      .post("/api/holds")
      .send({ seatIds: ["A9"], sessionId: "session-del" });
    const holdId = holdRes.body.hold.id;

    await request(app)
      .post(`/api/holds/${holdId}/confirm`)
      .send({ sessionId: "session-del" });

    const res = await request(app)
      .delete(`/api/holds/${holdId}`)
      .send({ sessionId: "session-del" });

    expect(res.status).toBe(409);
  });
});
