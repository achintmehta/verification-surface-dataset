/**
 * Database schema initialization and index creation.
 *
 * Index strategy:
 * - idx_logs_ts:           covers ORDER BY ts DESC (unfiltered queries)
 * - idx_logs_severity_ts:  covers WHERE severity = ? ORDER BY ts DESC
 * - idx_logs_service_ts:   covers WHERE service = ? ORDER BY ts DESC
 * - idx_logs_message_trgm: GIN trigram index for ILIKE substring search (if pg_trgm available)
 *
 * For deep-offset performance: PostgreSQL's index-only scans on (ts DESC) allow
 * the planner to skip to any offset efficiently when combined with the ordering index.
 */

export async function initSchema(db) {
  console.log('[schema] Initializing schema...');

  // Create the logs table
  await db.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id        BIGSERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT        NOT NULL CHECK (severity IN ('debug', 'info', 'warn', 'error')),
      service   TEXT        NOT NULL,
      message   TEXT        NOT NULL
    )
  `);

  // Index for ordering by ts (covers unfiltered windowed queries)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts
    ON logs (ts DESC, id DESC)
  `);

  // Composite index for severity + ts ordering (covers severity-filtered queries)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts
    ON logs (severity, ts DESC, id DESC)
  `);

  // Index for service + ts (optional but useful)
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_logs_service_ts
    ON logs (service, ts DESC, id DESC)
  `);

  // Attempt to create pg_trgm GIN index for fast ILIKE substring search
  let trgmAvailable = false;
  try {
    await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    trgmAvailable = true;
    console.log('[schema] pg_trgm extension available.');
  } catch (err) {
    console.warn('[schema] pg_trgm extension not available:', err.message);
  }

  if (trgmAvailable) {
    try {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_logs_message_trgm
        ON logs USING GIN (message gin_trgm_ops)
      `);
      console.log('[schema] GIN trigram index on message created.');
    } catch (err) {
      console.warn('[schema] Could not create GIN trigram index:', err.message);
    }
  }

  console.log('[schema] Schema initialization complete.');
}
