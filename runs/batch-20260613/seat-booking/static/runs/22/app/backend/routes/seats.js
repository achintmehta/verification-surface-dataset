import { Router } from "express";
import { getDb } from "../db.js";
import { expireStaleHolds } from "../expiry.js";

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its current effective status.
 * Held seats whose TTL has elapsed are reported as available.
 */
router.get("/", async (_req, res) => {
  try {
    const db = await getDb();

    // Lazy expiry: release stale holds before reading
    await expireStaleHolds(db);

    const { rows } = await db.query(`
      SELECT
        id,
        row_label,
        seat_number,
        CASE
          WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available'
          ELSE status
        END AS status,
        CASE
          WHEN status = 'held' AND hold_expires_at > NOW() THEN hold_id
          ELSE NULL
        END AS hold_id,
        CASE
          WHEN status = 'held' AND hold_expires_at > NOW() THEN hold_expires_at
          ELSE NULL
        END AS hold_expires_at,
        CASE
          WHEN status = 'held' AND hold_expires_at > NOW() THEN session_id
          WHEN status = 'booked' THEN session_id
          ELSE NULL
        END AS session_id,
        booked_by
      FROM seats
      ORDER BY row_label, seat_number
    `);

    res.json({ seats: rows });
  } catch (err) {
    console.error("GET /api/seats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
