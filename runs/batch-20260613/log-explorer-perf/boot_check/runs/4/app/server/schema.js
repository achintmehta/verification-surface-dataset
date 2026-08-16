/**
 * Creates the logs table and supporting indexes.
 * Idempotent — safe to call on every boot.
 */
export async function initSchema(db) {
  // Create table
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    )
  `);

  // Index for ordering by ts (covers unfiltered windowed queries)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
    ON logs (ts DESC)
  `);

  // Composite index for severity + ts ordering (covers severity-filtered queries)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
    ON logs (severity, ts DESC)
  `);

  // Try pg_trgm for fast ILIKE substring search
  let trgmAvailable = false;
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
      ON logs USING GIN (message gin_trgm_ops)
    `);
    trgmAvailable = true;
    console.log('[schema] pg_trgm GIN index created for message search.');
  } catch (e) {
    console.warn('[schema] pg_trgm not available, will use sequential scan for message search:', e.message);
  }

  // Also index on lower(message) for case-insensitive prefix/contains queries
  // This helps with the ts-based ordering even without trgm
  if (!trgmAvailable) {
    try {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_logs_message_lower
        ON logs (lower(message))
      `);
      console.log('[schema] lower(message) index created as fallback.');
    } catch (e) {
      console.warn('[schema] Could not create lower(message) index:', e.message);
    }
  }

  console.log('[schema] Schema and indexes ready.');
}
