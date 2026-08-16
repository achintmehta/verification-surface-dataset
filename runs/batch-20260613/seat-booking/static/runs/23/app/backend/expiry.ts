import { PGlite } from "@electric-sql/pglite";
import { broadcastSeatUpdates } from "./sse.ts";

interface ExpiredSeatRow {
  id: number;
  row_label: string;
  seat_number: number;
  hold_id: string;
}

export async function releaseExpiredHolds(db: PGlite): Promise<number[]> {
  const expiredSeats = await db.query<ExpiredSeatRow>(`
    UPDATE seats
    SET status = 'available',
        hold_id = NULL,
        hold_expires_at = NULL
    WHERE status = 'held'
      AND hold_expires_at IS NOT NULL
      AND hold_expires_at <= NOW()
    RETURNING id, row_label, seat_number, hold_id
  `);

  if (expiredSeats.rows.length === 0) {
    return [];
  }

  const holdIds = [...new Set(expiredSeats.rows.map((r) => r.hold_id))];

  if (holdIds.length > 0) {
    await db.query(
      `UPDATE holds SET status = 'expired' WHERE id = ANY($1::text[]) AND status = 'active'`,
      [holdIds]
    );
  }

  const updates = expiredSeats.rows.map((row) => ({
    seatId: row.id,
    rowLabel: row.row_label,
    seatNumber: row.seat_number,
    status: "available" as const,
    holdId: null,
    holdExpiresAt: null,
  }));

  broadcastSeatUpdates(updates);

  return expiredSeats.rows.map((r) => r.id);
}

export function startExpirySweep(
  db: PGlite,
  intervalMs: number = 1000
): ReturnType<typeof setInterval> {
  return setInterval(async () => {
    try {
      await releaseExpiredHolds(db);
    } catch (err) {
      console.error("Expiry sweep error:", err);
    }
  }, intervalMs);
}
