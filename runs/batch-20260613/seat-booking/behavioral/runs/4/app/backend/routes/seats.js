import { Router } from "express";
import { getDb } from "../db.js";
import { expireHolds } from "../expiry.js";

const router = Router();

/**
 * GET /api/seats
 * Returns every seat with its *effective* status:
 *   - A held seat whose hold has expired is reported as 'available'.
 */
router.get("/", async (req, res) => {
  try {
    const db = await getDb();

    // Lazily expire stale holds before reading
    await expireHolds(db);

    const { rows } = await db.query(`
      SELECT
        s.id,
        s.row_label,
        s.seat_number,
        s.status,
        s.hold_id,
        s.hold_expires_at,
        s.booked_by,
        h.expires_at AS hold_expires_at_from_hold,
        h.session_id AS held_by
      FROM seats s
      LEFT JOIN holds h ON h.id = s.hold_id AND s.status = 'held'
      ORDER BY s.row_label, s.seat_number
    `);

    const seats = rows.map((r) => ({
      id: r.id,
      row_label: r.row_label,
      seat_number: r.seat_number,
      status: r.status,
      hold_id: r.hold_id ?? null,
      hold_expires_at: r.hold_expires_at_from_hold ?? null,
      booked_by: r.booked_by ?? null,
    }));

    res.json({ seats });
  } catch (err) {
    console.error("[GET /api/seats]", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
