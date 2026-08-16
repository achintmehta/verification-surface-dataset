import { PGlite } from '@electric-sql/pglite';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.PGLITE_DIR || path.join(__dirname, '..', 'data', 'pgdata');

export const ROWS = parseInt(process.env.SEAT_ROWS || '5', 10);
export const SEATS_PER_ROW = parseInt(process.env.SEAT_COLS || '10', 10);
export const HOLD_TTL_MS = parseInt(process.env.HOLD_TTL_MS || '120000', 10); // 2 minutes

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  await initSchema(db);
  return db;
}

function rowLabel(i) {
  // 0 -> A, 1 -> B, ...
  let label = '';
  i += 1;
  while (i > 0) {
    const rem = (i - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    i = Math.floor((i - 1) / 26);
  }
  return label;
}

async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available','held','booked')),
      hold_id TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','confirmed','released','expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
    CREATE INDEX IF NOT EXISTS idx_seats_hold ON seats(hold_id);
  `);

  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM seats');
  if (rows[0].c === 0) {
    await db.transaction(async (tx) => {
      for (let r = 0; r < ROWS; r++) {
        const label = rowLabel(r);
        for (let s = 1; s <= SEATS_PER_ROW; s++) {
          const id = `${label}${s}`;
          await tx.query(
            'INSERT INTO seats (id, row_label, seat_number, status) VALUES ($1,$2,$3,$4)',
            [id, label, s, 'available']
          );
        }
      }
    });
  }
}
