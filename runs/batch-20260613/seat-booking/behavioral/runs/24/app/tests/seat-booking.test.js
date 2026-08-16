import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { initDb, getDb } from "../backend/db.js";
import {
  getAllSeats,
  createHold,
  confirmHold,
  releaseHold,
  getInventory,
  sweepExpiredHolds,
} from "../backend/seats.js";

let db;

beforeAll(async () => {
  // Remove any existing test data dir
  db = await initDb();
});

beforeEach(async () => {
  // Reset all seats to available
  await db.exec(`
    UPDATE seats SET
      status = 'available',
      hold_id = NULL,
      hold_expires_at = NULL,
      session_id = NULL,
      booked_by = NULL
  `);
});

describe("Seat Map", () => {
  it("should have 50 seats (5 rows × 10 seats)", async () => {
    const seats = await getAllSeats();
    expect(seats).toHaveLength(50);
  });

  it("all seats start as available", async () => {
    const seats = await getAllSeats();
    expect(seats.every((s) => s.status === "available")).toBe(true);
  });

  it("inventory should balance: available + held + booked = total", async () => {
    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.total).toBe(50);
  });
});

describe("Hold Flow", () => {
  it("should place a hold on requested seats", async () => {
    const seats = await getAllSeats();
    const seatIds = [seats[0].id, seats[1].id];
    const result = await createHold(seatIds, "session-1");
    expect(result.ok).toBe(true);
    expect(result.holdId).toBeTruthy();
    expect(result.seats).toHaveLength(2);
    expect(result.seats.every((s) => s.status === "held")).toBe(true);
  });

  it("should reject hold if any seat is already held (all-or-nothing)", async () => {
    const seats = await getAllSeats();
    const ids = [seats[0].id, seats[1].id];
    await createHold(ids, "session-1");

    // Try to hold overlapping seats
    const result = await createHold([seats[1].id, seats[2].id], "session-2");
    expect(result.error).toBe("conflict");
    expect(result.conflictingSeatIds).toContain(seats[1].id);

    // seat[2] should still be available (all-or-nothing)
    const updated = await getAllSeats();
    const seat2 = updated.find((s) => s.id === seats[2].id);
    expect(seat2.status).toBe("available");
  });

  it("should reject hold if any seat is booked", async () => {
    const seats = await getAllSeats();
    const ids = [seats[0].id];
    const hold = await createHold(ids, "session-1");
    await confirmHold(hold.holdId);

    // Try to hold the booked seat
    const result = await createHold([seats[0].id], "session-2");
    expect(result.error).toBe("conflict");
  });

  it("held seats block other users", async () => {
    const seats = await getAllSeats();
    await createHold([seats[5].id], "session-1");

    const result = await createHold([seats[5].id], "session-2");
    expect(result.error).toBe("conflict");
  });
});

describe("Confirm Flow", () => {
  it("should confirm a valid hold and mark seats as booked", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id, seats[1].id], "session-1");
    const result = await confirmHold(hold.holdId);
    expect(result.ok).toBe(true);
    expect(result.seats.every((s) => s.status === "booked")).toBe(true);
  });

  it("confirmation is idempotent: second confirm returns same result", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id], "session-1");

    const r1 = await confirmHold(hold.holdId);
    expect(r1.ok).toBe(true);
    expect(r1.seats).toHaveLength(1);

    const r2 = await confirmHold(hold.holdId);
    expect(r2.ok).toBe(true);
    expect(r2.alreadyConfirmed).toBe(true);

    // Verify only 1 seat booked total
    const inv = await getInventory();
    expect(inv.booked).toBe(1);
  });

  it("should reject confirmation of unknown hold", async () => {
    const result = await confirmHold("nonexistent-hold-id");
    expect(result.error).toBe("not_found");
  });

  it("should reject confirmation of expired hold", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id], "session-1");

    // Manually expire the hold
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );

    const result = await confirmHold(hold.holdId);
    expect(result.error).toBeTruthy();
    // "expired" or "not_found" (since sweep may release before confirm)
    expect(["expired", "not_found"]).toContain(result.error);

    // Seat should be available again
    const updated = await getAllSeats();
    const seat = updated.find((s) => s.id === seats[0].id);
    expect(seat.status).toBe("available");
  });

  it("no seat is ever booked by two different sessions", async () => {
    const seats = await getAllSeats();
    const seatId = seats[0].id;

    // Session 1 holds and confirms
    const hold1 = await createHold([seatId], "session-1");
    const confirm1 = await confirmHold(hold1.holdId);
    expect(confirm1.ok).toBe(true);

    // Session 2 tries to hold the same seat
    const hold2 = await createHold([seatId], "session-2");
    expect(hold2.error).toBe("conflict");

    // Verify the seat is booked by session-1 only
    const updated = await getAllSeats();
    const seat = updated.find(s => s.id === seatId);
    expect(seat.status).toBe("booked");
    expect(seat.booked_by).toBe("session-1");
  });
});

describe("Release Flow", () => {
  it("should release a hold and make seats available", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id, seats[1].id], "session-1");
    const result = await releaseHold(hold.holdId);
    expect(result.ok).toBe(true);

    const updated = await getAllSeats();
    expect(updated.find((s) => s.id === seats[0].id).status).toBe("available");
    expect(updated.find((s) => s.id === seats[1].id).status).toBe("available");
  });

  it("should fail to release an unknown hold", async () => {
    const result = await releaseHold("nonexistent");
    expect(result.error).toBe("not_found");
  });
});

describe("Auto-Expiry", () => {
  it("expired holds make seats available automatically", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id, seats[1].id], "session-1");

    // Manually expire
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );

    // Fetch seats – should trigger sweep
    const updated = await getAllSeats();
    expect(updated.find((s) => s.id === seats[0].id).status).toBe("available");
    expect(updated.find((s) => s.id === seats[1].id).status).toBe("available");
  });

  it("expired seats can be re-held by another user", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id], "session-1");

    // Expire
    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );

    // Another user can now hold it
    const hold2 = await createHold([seats[0].id], "session-2");
    expect(hold2.ok).toBe(true);
  });
});

describe("Inventory Integrity", () => {
  it("inventory always balances after hold + confirm", async () => {
    const seats = await getAllSeats();
    await createHold([seats[0].id, seats[1].id], "s1");

    let inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.held).toBe(2);

    // Confirm
    const hold = (await db.query("SELECT hold_id FROM seats WHERE id = $1", [seats[0].id])).rows[0].hold_id;
    await confirmHold(hold);

    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.booked).toBe(2);
    expect(inv.held).toBe(0);
  });

  it("inventory balances after hold + release", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id], "s1");

    let inv = await getInventory();
    expect(inv.held).toBe(1);

    await releaseHold(hold.holdId);

    inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.held).toBe(0);
    expect(inv.available).toBe(50);
  });

  it("inventory balances after hold + expiry", async () => {
    const seats = await getAllSeats();
    const hold = await createHold([seats[0].id, seats[1].id, seats[2].id], "s1");

    await db.query(
      `UPDATE seats SET hold_expires_at = NOW() - INTERVAL '1 second' WHERE hold_id = $1`,
      [hold.holdId]
    );

    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.available).toBe(50);
    expect(inv.held).toBe(0);
  });
});

describe("Concurrency", () => {
  it("concurrent holds for the same seat: exactly one succeeds", async () => {
    const seats = await getAllSeats();
    const seatId = seats[0].id;

    // Fire 10 concurrent hold requests for the same seat
    const promises = Array.from({ length: 10 }, (_, i) =>
      createHold([seatId], `concurrent-session-${i}`)
    );

    const results = await Promise.all(promises);
    const successes = results.filter((r) => r.ok);
    const conflicts = results.filter((r) => r.error === "conflict");

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(9);

    // Verify the seat is held by exactly one session
    const updated = await getAllSeats();
    const seat = updated.find((s) => s.id === seatId);
    expect(seat.status).toBe("held");
  });

  it("concurrent holds for overlapping seats: no double-hold", async () => {
    const seats = await getAllSeats();
    // User A wants seats [0,1,2], User B wants seats [2,3,4]
    const idsA = [seats[0].id, seats[1].id, seats[2].id];
    const idsB = [seats[2].id, seats[3].id, seats[4].id];

    const [resultA, resultB] = await Promise.all([
      createHold(idsA, "session-A"),
      createHold(idsB, "session-B"),
    ]);

    // Exactly one should succeed, one should fail
    const successes = [resultA, resultB].filter((r) => r.ok);
    const conflicts = [resultA, resultB].filter((r) => r.error === "conflict");

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // Inventory should be consistent
    const inv = await getInventory();
    expect(inv.available + inv.held + inv.booked).toBe(inv.total);
    expect(inv.held).toBe(3); // exactly 3 seats held
  });
});
