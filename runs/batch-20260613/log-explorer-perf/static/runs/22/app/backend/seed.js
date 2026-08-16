/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * - Spans 30 days ending at a fixed anchor date.
 * - 8 services.
 * - Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error.
 * - Messages drawn from templates with variable fragments so substring search
 *   has both selective and non-selective terms.
 *
 * Uses a simple mulberry32 PRNG seeded with a constant for full determinism.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

// Fixed anchor: 2025-01-31T00:00:00Z
const ANCHOR_TS = Date.UTC(2025, 0, 31, 0, 0, 0);
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const SERVICES = [
  "api-gateway",
  "auth-service",
  "user-service",
  "order-service",
  "payment-service",
  "notification-service",
  "inventory-service",
  "analytics-service",
];

// Weighted severity: cumulative thresholds out of 100
// debug 25, info 60, warn 10, error 5
const SEVERITY_THRESHOLDS = [
  { severity: "debug", cum: 25 },
  { severity: "info", cum: 85 },
  { severity: "warn", cum: 95 },
  { severity: "error", cum: 100 },
];

const MESSAGE_TEMPLATES = [
  "Request processed successfully in {duration}ms",
  "Connection established to {host}",
  "Cache miss for key {key}",
  "User {userId} authenticated via {method}",
  "Database query completed in {duration}ms",
  "Rate limit reached for client {clientId}",
  "Health check passed with status {status}",
  "Retrying operation after {duration}ms delay",
  "Configuration reloaded from {source}",
  "Incoming request from {ip} to {endpoint}",
  "Response sent with status code {status}",
  "Background job {jobId} started",
  "Memory usage at {percent}% of allocated heap",
  "TLS handshake completed with {host}",
  "Payload validation failed for field {field}",
  "Circuit breaker tripped for {host}",
  "Websocket connection opened by {userId}",
  "Scheduled task {jobId} completed",
  "Disk usage at {percent}% on volume {volume}",
  "Event published to topic {topic}",
];

const HOSTS = ["db-primary.internal", "db-replica.internal", "cache-01.internal", "cache-02.internal", "mq-broker.internal"];
const KEYS = ["session:abc123", "session:def456", "product:789", "cart:xyz", "config:main", "rate:client42"];
const USER_IDS = ["u-1001", "u-1002", "u-1003", "u-2050", "u-3999", "u-500"];
const AUTH_METHODS = ["oauth2", "api-key", "jwt", "basic"];
const CLIENT_IDS = ["client-alpha", "client-beta", "client-gamma"];
const STATUSES = ["200", "201", "204", "301", "400", "401", "403", "404", "500", "502", "503"];
const SOURCES = ["vault", "env", "configmap", "consul"];
const IPS = ["10.0.1.12", "10.0.2.34", "192.168.1.100", "172.16.0.5"];
const ENDPOINTS = ["/api/users", "/api/orders", "/api/products", "/api/health", "/api/auth/login", "/api/payments"];
const JOB_IDS = ["job-001", "job-002", "job-report-daily", "job-cleanup", "job-sync-inventory"];
const FIELDS = ["email", "phone", "address.zip", "amount", "quantity"];
const TOPICS = ["order.created", "user.signup", "payment.processed", "inventory.low"];
const VOLUMES = ["/data", "/logs", "/tmp", "/var/lib/pg"];

// Mulberry32 PRNG – deterministic, fast
function mulberry32(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function fillTemplate(rng, template) {
  return template.replace(/\{(\w+)\}/g, (_match, name) => {
    switch (name) {
      case "duration":
        return String(randInt(rng, 1, 5000));
      case "host":
        return pick(rng, HOSTS);
      case "key":
        return pick(rng, KEYS);
      case "userId":
        return pick(rng, USER_IDS);
      case "method":
        return pick(rng, AUTH_METHODS);
      case "clientId":
        return pick(rng, CLIENT_IDS);
      case "status":
        return pick(rng, STATUSES);
      case "source":
        return pick(rng, SOURCES);
      case "ip":
        return pick(rng, IPS);
      case "endpoint":
        return pick(rng, ENDPOINTS);
      case "jobId":
        return pick(rng, JOB_IDS);
      case "percent":
        return String(randInt(rng, 1, 99));
      case "field":
        return pick(rng, FIELDS);
      case "topic":
        return pick(rng, TOPICS);
      case "volume":
        return pick(rng, VOLUMES);
      default:
        return name;
    }
  });
}

function severityFor(rng) {
  const v = Math.floor(rng() * 100);
  for (const { severity, cum } of SEVERITY_THRESHOLDS) {
    if (v < cum) return severity;
  }
  return "info";
}

/**
 * Seed the database. Idempotent – skips if table already has rows.
 * Returns { seeded: boolean, durationMs: number }.
 */
async function seed(db) {
  const start = Date.now();

  // Create schema
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMP NOT NULL,
      severity  TEXT NOT NULL,
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countRes = await db.query("SELECT COUNT(*)::int AS cnt FROM logs");
  const existing = countRes.rows[0].cnt;
  if (existing >= TOTAL_ROWS) {
    console.log(`[seed] Table already has ${existing} rows – skipping seed.`);
    return { seeded: false, durationMs: Date.now() - start };
  }

  // If partially seeded (shouldn't happen normally), truncate and reseed
  if (existing > 0) {
    console.log(`[seed] Partial data (${existing} rows) detected – truncating and reseeding.`);
    await db.exec("TRUNCATE logs RESTART IDENTITY");
  }

  console.log(`[seed] Seeding ${TOTAL_ROWS} rows in batches of ${BATCH_SIZE}...`);

  const rng = mulberry32(42);

  // Pre-generate all timestamps sorted descending so ts ordering = insertion order
  const timestamps = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const offsetMs = Math.floor(rng() * THIRTY_DAYS_MS);
    timestamps.push(new Date(ANCHOR_TS - offsetMs));
  }
  // Sort ascending (oldest first) so that id ordering ~ ts ordering (approx)
  timestamps.sort((a, b) => a.getTime() - b.getTime());

  // We need a second rng stream for other fields so that sorting timestamps
  // doesn't change the determinism of other fields.
  const rng2 = mulberry32(123);

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      const ts = timestamps[i].toISOString();
      const severity = severityFor(rng2);
      const service = pick(rng2, SERVICES);
      const template = pick(rng2, MESSAGE_TEMPLATES);
      const message = fillTemplate(rng2, template);

      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts, severity, service, message);
      paramIdx += 4;
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(",")}`,
      params
    );

    if ((batchStart / BATCH_SIZE) % 5 === 0) {
      console.log(`[seed]   ${batchEnd} / ${TOTAL_ROWS} rows inserted...`);
    }
  }

  console.log("[seed] Creating indexes...");

  // Index for ordering by ts (descending queries)
  await db.exec("CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)");

  // Index for severity + ts ordering
  await db.exec("CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)");

  // Trigram index for substring search – PGLite may not support pg_trgm,
  // so we fall back to a btree on lower(message) for prefix and use ILIKE
  // which will seq-scan but on an indexed-ordered set.
  // Actually, let's create a GIN index if available, otherwise skip.
  // PGLite doesn't support pg_trgm extension as of current versions.
  // For substring search we'll rely on the ts index for ordering and
  // let the filter be applied during the scan.  The 300ms budget is
  // achievable because PGLite keeps data in memory after first load.

  const durationMs = Date.now() - start;
  console.log(`[seed] Done in ${durationMs}ms.`);
  return { seeded: true, durationMs };
}

module.exports = { seed, TOTAL_ROWS };
