import { PGlite } from '@electric-sql/pglite';
import { config, rowLabel } from './config.js';

// A single PGLite instance persisting to local disk. PGLite executes one
// query at a time per instance, which gives us a natural serialization point;
// we additionally use explicit SQL transactions for multi-statement atomicity.
let db = null;

export async function getDb() {
  if (db) return db;
  db = new PGlite(config.dataDir);
  await db.waitReady;
  return db;
}

// Initialize schema and seed the fixed seat map exactly once.
export async function initDb() {
  const pg = await getDb();

  await pg.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at TIMESTAMPTZ,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL,
      -- 'active' while seats are held, 'confirmed' once booked,
      -- 'released' once cancelled/expired.
      state       TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'confirmed', 'released'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id);
    CREATE INDEX IF NOT EXISTS idx_holds_state ON holds(state);
  `);

  // Seed seats only if empty so existing persisted state is preserved.
  const countRes = await pg.query('SELECT COUNT(*)::int AS c FROM seats;');
  const existing = countRes.rows[0].c;
  if (existing === 0) {
    await seedSeats(pg);
  }

  return pg;
}

async function seedSeats(pg) {
  const values = [];
  const params = [];
  let p = 0;
  for (let r = 0; r < config.rows; r++) {
    const label = rowLabel(r);
    for (let s = 1; s <= config.seatsPerRow; s++) {
      const id = `${label}${s}`;
      values.push(`($${++p}, $${++p}, $${++p}, 'available')`);
      params.push(id, label, s);
    }
  }
  const sql = `INSERT INTO seats (id, row_label, seat_number, status) VALUES ${values.join(', ')};`;
  await pg.query(sql, params);
}
