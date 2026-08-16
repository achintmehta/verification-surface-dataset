import { getDb } from "./db.js";
import { broadcast } from "./sse.js";

/**
 * Expire all stale holds: release seats whose hold has passed its TTL.
 * This function should be called within a serialized context (mutex).
 * Returns the list of seat changes that were broadcast.
 */
export async function expireStaleHolds() {
  const db = await getDb();
  const changes = [];

  // Find and release expired held seats
  const result = await db.query(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL,
        session_id = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number
  `);

  if (result.rows.length > 0) {
    // Also mark the corresponding holds as expired
    await db.query(`
      UPDATE holds
      SET status = 'expired'
      WHERE status = 'active'
        AND expires_at <= NOW()
    `);

    for (const row of result.rows) {
      const change = {
        seatId: row.id,
        rowLabel: row.row_label,
        seatNumber: row.seat_number,
        status: "available",
        holdId: null,
        holdExpiresAt: null,
        sessionId: null,
      };
      changes.push(change);
    }

    // Broadcast all released seats
    if (changes.length > 0) {
      broadcast("seatUpdates", changes);
    }
  }

  return changes;
}

let sweepInterval = null;
// The sweep needs access to the mutex from routes to serialize properly
let sweepMutexFn = null;

export function setSweepMutex(mutexFn) {
  sweepMutexFn = mutexFn;
}

export function startPeriodicSweep(intervalMs = 1000) {
  if (sweepInterval) return;
  sweepInterval = setInterval(async () => {
    try {
      if (sweepMutexFn) {
        await sweepMutexFn(() => expireStaleHolds());
      } else {
        await expireStaleHolds();
      }
    } catch (e) {
      console.error("Sweep error:", e);
    }
  }, intervalMs);
}

export function stopPeriodicSweep() {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
