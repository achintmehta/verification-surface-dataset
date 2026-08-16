import { PGlite } from '@electric-sql/pglite';
import { config, rowLabels } from './config.js';

let db = null;

// Serialize all write operations through a single in-process promise chain.
// PGLite runs an embedded single-connection Postgres; funnelling mutating
// operations through this queue guarantees that each hold/confirm/release
// transaction runs to completion before the next begins, which (combined with
// the conditional SQL inside each transaction) makes seat acquisition atomic
// even under many concurrent HTTP requests.
let writeChain = Promise.resolve();

export function withTransaction(fn) {
  const run = async () => {
    // PGLite exposes db.transaction(tx => ...) which BEGIN/COMMITs around fn,
    // rolling back automatically if fn throws.
    return db.transaction(async (tx) => fn(tx));
  };
  // Chain the work; isolate the chain from individual failures so one failed
  // operation does not poison subsequent ones.
  const result = writeChain.then(run, run);
  writeChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export async function initDb() {
  db = new PGlite(config.dataDir);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id              TEXT PRIMARY KEY,
      row_label       TEXT NOT NULL,
      seat_number     INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'available'
                        CHECK (status IN ('available', 'held', 'booked')),
      hold_id         TEXT,
      hold_expires_at BIGINT,
      booked_by       TEXT
    );

    CREATE TABLE IF NOT EXISTS holds (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      created_at  BIGINT NOT NULL,
      expires_at  BIGINT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );

    CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats (hold_id);
    CREATE INDEX IF NOT EXISTS idx_seats_status ON seats (status);
  `);

  await seedSeats();
  return db;
}

// Seed the fixed seat map exactly once. Idempotent: if seats already exist we
// leave their (possibly booked) state untouched.
async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats;');
  if (rows[0].count > 0) return;

  const labels = rowLabels(config.rows);
  const values = [];
  const params = [];
  let p = 0;
  for (const label of labels) {
    for (let n = 1; n <= config.seatsPerRow; n += 1) {
      const id = `${label}${n}`;
      values.push(`($${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(id, label, n);
      p += 3;
    }
  }

  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')};`,
    params,
  );
}
