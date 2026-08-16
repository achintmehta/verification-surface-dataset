import { PGlite } from '@electric-sql/pglite';
import { DATA_DIR, ROWS, SEATS_PER_ROW } from './config.js';

let db = null;

// A single serialized queue for write transactions. PGLite runs a single
// embedded Postgres instance with no inter-process concurrency, but JavaScript
// async interleaving can still interleave multiple `await`-ed statements from
// different requests. To make multi-statement transactions truly atomic with
// respect to each other we serialize them through this promise chain so that
// only one transaction body runs at a time.
let txQueue = Promise.resolve();

const ROW_LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export async function initDb() {
  db = new PGlite(DATA_DIR);
  await db.waitReady;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS seats (
      id TEXT PRIMARY KEY,
      row_label TEXT NOT NULL,
      seat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'available'
        CHECK (status IN ('available', 'held', 'booked')),
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
        CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
    );
  `);

  await seedSeats();
  return db;
}

async function seedSeats() {
  const { rows } = await db.query('SELECT COUNT(*)::int AS count FROM seats');
  if (rows[0].count > 0) return;

  const values = [];
  const params = [];
  let p = 1;
  for (let r = 0; r < ROWS; r++) {
    const label = ROW_LABELS[r];
    for (let n = 1; n <= SEATS_PER_ROW; n++) {
      const id = `${label}${n}`;
      values.push(`($${p++}, $${p++}, $${p++})`);
      params.push(id, label, n);
    }
  }
  await db.query(
    `INSERT INTO seats (id, row_label, seat_number) VALUES ${values.join(', ')}`,
    params
  );
}

export function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// Run `fn` exclusively with respect to other queued transactions. `fn` receives
// the db handle and is responsible for issuing BEGIN/COMMIT/ROLLBACK as needed.
// We provide a helper wrapper `transaction` below that manages that.
export function runExclusive(fn) {
  const result = txQueue.then(() => fn());
  // Keep the chain alive even if fn rejects, so the queue does not deadlock.
  txQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// Execute `fn(client)` inside a serialized SQL transaction. Commits on success,
// rolls back on throw. `client` is the db handle (statements run on the same
// connection since PGlite is a single connection).
export function transaction(fn) {
  return runExclusive(async () => {
    const client = getDb();
    await client.exec('BEGIN');
    try {
      const out = await fn(client);
      await client.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        await client.exec('ROLLBACK');
      } catch {
        // ignore rollback errors
      }
      throw err;
    }
  });
}
