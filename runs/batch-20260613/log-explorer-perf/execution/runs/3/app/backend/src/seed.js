/**
 * Deterministic seed of 100,000 log entries.
 *
 * Determinism: every value is derived from the row index using simple
 * arithmetic / modular arithmetic — no Math.random(), no Date.now().
 *
 * Distribution targets:
 *   severity: debug ~60%, info ~25%, warn ~10%, error ~5%
 *   services: 8 services, round-robin with slight skew
 *   timestamps: evenly spread over 30 days (newest first when sorted DESC)
 *   messages: drawn from templates with variable fragments so substring
 *             search has both selective (rare) and non-selective (common) terms
 *
 * Returns: true if seeding was performed, false if skipped.
 */

const TOTAL_ROWS = 100_000;

const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'search-service',
  'analytics-service',
];

// Severity distribution: 60/25/10/5
// We'll use a lookup table of 20 slots
const SEVERITY_POOL = [
  ...Array(12).fill('debug'),
  ...Array(5).fill('info'),
  ...Array(2).fill('warn'),
  ...Array(1).fill('error'),
];

const MESSAGE_TEMPLATES = [
  // debug templates (indices 0-7)
  (i) => `Processing request ${i} with correlation-id corr-${i % 9973}`,
  (i) => `Cache lookup for key session-${i % 4999} returned ${i % 3 === 0 ? 'HIT' : 'MISS'}`,
  (i) => `Database query executed in ${(i % 450) + 1}ms for table users`,
  (i) => `Heartbeat ping from worker-${i % 16} acknowledged`,
  (i) => `Serializing response payload of ${(i % 8192) + 64} bytes`,
  (i) => `Connection pool size: ${(i % 20) + 1} active, ${(i % 5)} idle`,
  (i) => `Retry attempt ${(i % 3) + 1} for downstream call to inventory-service`,
  (i) => `Token validation succeeded for user uid-${i % 50021}`,
  // info templates (indices 8-12)
  (i) => `User uid-${i % 50021} logged in successfully from IP 10.${i % 256}.${(i >> 8) % 256}.1`,
  (i) => `Order ord-${i % 19997} created for customer cust-${i % 9973}`,
  (i) => `Payment processed successfully for amount $${((i % 99900) + 100) / 100} USD`,
  (i) => `Email notification dispatched to user uid-${i % 50021}`,
  (i) => `Search index updated with ${(i % 500) + 1} new documents`,
  // warn templates (indices 13-14)
  (i) => `Slow query detected: ${(i % 2000) + 500}ms for SELECT on orders table`,
  (i) => `Rate limit threshold at ${(i % 40) + 60}% for endpoint /api/checkout`,
  // error templates (indices 15-16)
  (i) => `Failed to connect to database after ${(i % 3) + 1} retries: connection refused`,
  (i) => `Unhandled exception in payment processor: timeout after 30000ms`,
  // extra debug/info for variety
  (i) => `Config reload triggered by signal SIGHUP on instance inst-${i % 8}`,
  (i) => `Metrics flushed: ${(i % 1000) + 1} data points sent to collector`,
  (i) => `Feature flag feature-${i % 50}-enabled evaluated to ${i % 2 === 0 ? 'true' : 'false'}`,
];

function getSeverity(i) {
  return SEVERITY_POOL[i % SEVERITY_POOL.length];
}

function getService(i) {
  return SERVICES[i % SERVICES.length];
}

function getTimestamp(i) {
  // Spread 100k rows over 30 days (2,592,000 seconds)
  // Row 0 = newest (now - 0s), row 99999 = oldest (now - 30 days)
  // Use a fixed epoch so it's deterministic across restarts
  const BASE_TS = 1_700_000_000_000; // fixed epoch ms (Nov 2023)
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms
  const offsetMs = Math.floor((i / (TOTAL_ROWS - 1)) * SPAN_MS);
  return new Date(BASE_TS - offsetMs).toISOString();
}

function getMessage(i) {
  // Pick template based on severity to keep distribution coherent
  const sev = getSeverity(i);
  let templateIdx;
  if (sev === 'debug') {
    templateIdx = i % 8; // templates 0-7
  } else if (sev === 'info') {
    templateIdx = 8 + (i % 5); // templates 8-12
  } else if (sev === 'warn') {
    templateIdx = 13 + (i % 2); // templates 13-14
  } else {
    templateIdx = 15 + (i % 2); // templates 15-16
  }
  return MESSAGE_TEMPLATES[templateIdx](i);
}

/**
 * Seed the database if it hasn't been seeded yet.
 * @returns {boolean} true if seeding was performed, false if skipped
 */
export async function seedIfNeeded(db) {
  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existing = parseInt(countResult.rows[0].cnt, 10);

  if (existing >= TOTAL_ROWS) {
    console.log(`[seed] Table already has ${existing} rows — skipping seed.`);
    return false;
  }

  if (existing > 0) {
    console.log(`[seed] Partial seed detected (${existing} rows) — truncating and reseeding.`);
    await db.query('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows...`);
  const t0 = Date.now();

  const BATCH_SIZE = 1000;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      values.push(
        `($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`
      );
      params.push(
        getTimestamp(i),
        getSeverity(i),
        getService(i),
        getMessage(i)
      );
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((batchStart / BATCH_SIZE) % 20 === 0) {
      console.log(`[seed] Inserted ${batchEnd} / ${TOTAL_ROWS} rows...`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[seed] Done. Seeded ${TOTAL_ROWS} rows in ${elapsed}s.`);
  return true;
}
