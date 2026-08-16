import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'data', 'pglite');

await mkdir(dataDir, { recursive: true });

export const db = new PGlite(dataDir);

export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;
export const HOLD_TTL_SECONDS = Number(process.env.HOLD_TTL_SECONDS || 60);

export async function query(sql, params = []) {
  return db.query(sql, params);
}

export async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available', 'held', 'booked')),
      hold_id TEXT,
      hold_session_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT,
      booked_hold_id TEXT,
      booked_at TIMESTAMPTZ,
      CHECK (
        (status = 'available' AND hold_id IS NULL AND hold_session_id IS NULL AND hold_expires_at IS NULL)
        OR (status = 'held' AND hold_id IS NOT NULL AND hold_session_id IS NOT NULL AND hold_expires_at IS NOT NULL)
        OR (status = 'booked' AND booked_by IS NOT NULL)
      )
    );
  `);

  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id)');
  await db.query("CREATE INDEX IF NOT EXISTS idx_seats_expiry ON seats(hold_expires_at) WHERE status = 'held'");
  await db.query('CREATE INDEX IF NOT EXISTS idx_seats_booked_hold_id ON seats(booked_hold_id)');

  const countResult = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  const count = Number(countResult.rows[0]?.count || 0);
  if (count === 0) {
    const values = [];
    const params = [];
    let i = 1;
    for (const row of ROWS) {
      for (let seat = 1; seat <= SEATS_PER_ROW; seat += 1) {
        const id = `${row}${seat}`;
        values.push(`($${i++}, $${i++}, $${i++}, 'available')`);
        params.push(id, row, seat);
      }
    }
    await db.query(
      `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')}`,
      params,
    );
  }
}

export function normalizeSeat(row) {
  return {
    id: row.id,
    rowLabel: row.row_label,
    seatNumber: Number(row.seat_number),
    status: row.status,
    holdId: row.hold_id,
    holdSessionId: row.hold_session_id,
    holdExpiresAt: row.hold_expires_at ? new Date(row.hold_expires_at).toISOString() : null,
    bookedBy: row.booked_by,
    bookedHoldId: row.booked_hold_id,
    bookedAt: row.booked_at ? new Date(row.booked_at).toISOString() : null,
  };
}
