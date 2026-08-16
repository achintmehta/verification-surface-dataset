import { PGlite } from "@electric-sql/pglite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "..", "data", "logdb");

let db;
let dbReady;

export async function getDb() {
  if (db) {
    await dbReady;
    return db;
  }
  db = new PGlite(DB_PATH);
  // PGlite may expose waitReady as a property or method; handle both
  if (db.waitReady) {
    dbReady = typeof db.waitReady === "function" ? db.waitReady() : db.waitReady;
    await dbReady;
  }
  return db;
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Seed data constants ──────────────────────────────────────────────────────

const SERVICES = [
  "api-gateway",
  "auth-service",
  "payment-service",
  "user-service",
  "notification-service",
  "search-service",
  "cache-service",
  "worker-service",
];

const SEVERITIES = ["debug", "info", "warn", "error"];
// Cumulative weights: 60% debug, 25% info, 10% warn, 5% error
const SEVERITY_CUM_WEIGHTS = [0.6, 0.85, 0.95, 1.0];

const MESSAGE_TEMPLATES = [
  "Request processed successfully in {duration}ms",
  "Connection established to upstream host {host}",
  "Cache miss for key {key}, fetching from database",
  "Rate limit threshold reached for client {client_id}",
  "Health check passed, uptime {uptime}s",
  "Retrying failed operation, attempt {attempt} of 3",
  "Database query executed in {duration}ms, rows returned: {rows}",
  "Configuration reloaded from environment variables",
  "TLS handshake completed with cipher {cipher}",
  "Session {session_id} expired after timeout",
  "Incoming request: {method} {path} from {ip}",
  "Response sent: status {status} in {duration}ms",
  "Memory usage at {mem_pct}% of allocated heap",
  "Disk write completed: {bytes} bytes to {file}",
  "Worker spawned for job {job_id} in queue {queue}",
  "Authentication token validated for user {user_id}",
  "Outbound webhook delivered to {webhook_url}",
  "Graceful shutdown initiated, draining connections",
  "Index rebuild started on collection {collection}",
  "Payload validation failed: missing field {field}",
];

const HOSTS = ["10.0.1.1", "10.0.1.2", "10.0.2.5", "10.0.3.10", "192.168.1.100"];
const KEYS = ["user:1001", "session:abc", "config:main", "cache:products", "token:xyz"];
const CLIENT_IDS = ["client-a", "client-b", "client-c", "client-d"];
const CIPHERS = ["AES-256-GCM", "CHACHA20-POLY1305", "AES-128-CBC"];
const METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH"];
const PATHS = ["/api/users", "/api/orders", "/api/products", "/api/health", "/api/search"];
const IPS = ["203.0.113.5", "198.51.100.22", "192.0.2.1", "172.16.0.50"];
const FILES = ["/var/log/app.log", "/tmp/dump.bin", "/data/export.csv"];
const QUEUES = ["default", "critical", "batch", "emails"];
const COLLECTIONS = ["users", "orders", "products", "sessions"];
const FIELDS = ["email", "name", "amount", "timestamp", "id"];
const STATUSES = ["200", "201", "204", "301", "400", "401", "403", "404", "500", "502", "503"];

function pickSeverity(rand) {
  const r = rand();
  for (let i = 0; i < SEVERITY_CUM_WEIGHTS.length; i++) {
    if (r < SEVERITY_CUM_WEIGHTS[i]) return SEVERITIES[i];
  }
  return SEVERITIES[3];
}

function pick(arr, rand) {
  return arr[Math.floor(rand() * arr.length)];
}

function fillTemplate(template, rand) {
  return template
    .replace("{duration}", String(Math.floor(rand() * 2000)))
    .replace("{host}", pick(HOSTS, rand))
    .replace("{key}", pick(KEYS, rand))
    .replace("{client_id}", pick(CLIENT_IDS, rand))
    .replace("{uptime}", String(Math.floor(rand() * 864000)))
    .replace("{attempt}", String(Math.floor(rand() * 3) + 1))
    .replace("{rows}", String(Math.floor(rand() * 5000)))
    .replace("{cipher}", pick(CIPHERS, rand))
    .replace("{session_id}", "sess-" + String(Math.floor(rand() * 100000)))
    .replace("{method}", pick(METHODS, rand))
    .replace("{path}", pick(PATHS, rand))
    .replace("{ip}", pick(IPS, rand))
    .replace("{status}", pick(STATUSES, rand))
    .replace("{mem_pct}", String(Math.floor(rand() * 100)))
    .replace("{bytes}", String(Math.floor(rand() * 10000000)))
    .replace("{file}", pick(FILES, rand))
    .replace("{job_id}", "job-" + String(Math.floor(rand() * 100000)))
    .replace("{queue}", pick(QUEUES, rand))
    .replace("{user_id}", "usr-" + String(Math.floor(rand() * 50000)))
    .replace("{webhook_url}", "https://hooks.example.com/" + String(Math.floor(rand() * 1000)))
    .replace("{collection}", pick(COLLECTIONS, rand))
    .replace("{field}", pick(FIELDS, rand));
}

// ── Schema + Seed ────────────────────────────────────────────────────────────

export async function initSchema(db) {
  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMP NOT NULL,
      severity  TEXT NOT NULL,
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );
  `);
}

export async function needsSeed(db) {
  const res = await db.query("SELECT COUNT(*)::int AS cnt FROM logs;");
  const count = res.rows[0].cnt;
  if (count > 0 && count < 100000) {
    // Partial seed detected — wipe and re-seed
    console.log(`Partial seed detected (${count} rows), clearing for re-seed...`);
    await db.exec("DELETE FROM logs;");
    return true;
  }
  return count === 0;
}

export async function seedLogs(db) {
  const TOTAL = 100_000;
  const BATCH = 1000;
  const rand = mulberry32(42);

  // Fixed base timestamp: 2025-01-01T00:00:00.000Z 
  // Using a fixed date so the seed is truly deterministic across runs
  const baseTs = new Date("2025-01-01T00:00:00.000Z").getTime();
  // Spread 100k entries across 30 days ~= 2592000000 ms
  const spanMs = 30 * 24 * 60 * 60 * 1000;

  console.log(`Seeding ${TOTAL} log entries in batches of ${BATCH}...`);
  const startTime = Date.now();

  for (let batch = 0; batch < TOTAL / BATCH; batch++) {
    // Build a multi-row INSERT
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = 0; i < BATCH; i++) {
      const rowNum = batch * BATCH + i;
      // Deterministic timestamp: evenly spaced + small jitter
      const tsMs = baseTs + (rowNum / TOTAL) * spanMs + Math.floor(rand() * 25920);
      const ts = new Date(tsMs).toISOString();
      const severity = pickSeverity(rand);
      const service = pick(SERVICES, rand);
      const template = pick(MESSAGE_TEMPLATES, rand);
      const message = fillTemplate(template, rand);

      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts, severity, service, message);
      paramIdx += 4;
    }

    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(", ")}`,
      params
    );

    if ((batch + 1) % 10 === 0) {
      const pct = (((batch + 1) * BATCH) / TOTAL * 100).toFixed(0);
      console.log(`  Seeded ${(batch + 1) * BATCH} / ${TOTAL} (${pct}%)`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
}

export async function createIndexes(db) {
  console.log("Creating indexes...");
  const start = Date.now();

  // Index for ordering by ts descending (general queries)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);`);

  // Composite index for severity + ts ordering
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);`);

  // Trigram index for substring search — PGLite supports pg_trgm
  // Fall back to btree on message if trgm not available
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING gin (message gin_trgm_ops);`);
    console.log("  Created trigram index on message");
  } catch (e) {
    console.log("  pg_trgm not available, creating btree index on message as fallback");
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message ON logs (message);`);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Indexes created in ${elapsed}s`);
}

export async function initDatabase() {
  const db = await getDb();
  await initSchema(db);
  const shouldSeed = await needsSeed(db);
  if (shouldSeed) {
    await seedLogs(db);
  } else {
    console.log("Database already seeded, skipping.");
  }
  // Always ensure indexes exist (IF NOT EXISTS makes this idempotent)
  await createIndexes(db);
  return db;
}
