import { PGlite } from '@electric-sql/pglite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'pgdata');

let db;

export async function getDb() {
  if (db) return db;
  db = new PGlite(DATA_DIR);
  await db.waitReady;
  return db;
}

export async function initSchema(db) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `);
}

export async function isSeeded(db) {
  const result = await db.query('SELECT COUNT(*)::int AS cnt FROM logs');
  return result.rows[0].cnt >= 100000;
}

export async function seedLogs(db) {
  const TOTAL = 100000;
  const BATCH_SIZE = 2000;

  const severities = ['debug', 'info', 'warn', 'error'];
  // Distribution: 60% debug, 25% info, 10% warn, 5% error
  // Cumulative: debug < 60, info < 85, warn < 95, error < 100
  const severityThresholds = [60, 85, 95, 100];

  const services = [
    'api-gateway',
    'auth-service',
    'user-service',
    'order-service',
    'payment-service',
    'notification-service',
    'inventory-service',
    'analytics-service'
  ];

  // Message templates with variable fragments for selective/non-selective search
  const messageTemplates = [
    (i) => `Request processed successfully for user_${i % 500} in ${(i % 200) + 10}ms`,
    (i) => `Connection established to database replica-${i % 5}`,
    (i) => `Cache miss for key session:${i % 1000}, fetching from store`,
    (i) => `Health check passed: cpu=${(i % 80) + 10}% mem=${(i % 60) + 20}%`,
    (i) => `Rate limit threshold reached for client_${i % 100}: ${(i % 50) + 100} req/s`,
    (i) => `Timeout waiting for upstream service after ${(i % 5000) + 1000}ms`,
    (i) => `Configuration reloaded: ${(i % 10) + 1} parameters updated`,
    (i) => `Retrying failed operation attempt ${(i % 3) + 1}/3 for transaction txn_${i % 10000}`,
    (i) => `Memory usage alert: heap=${(i % 512) + 256}MB, rss=${(i % 1024) + 512}MB`,
    (i) => `Incoming webhook received from partner_${i % 20} with payload size ${(i % 5000) + 100} bytes`,
    (i) => `Query executed in ${(i % 100) + 1}ms: SELECT * FROM orders WHERE id = ${i % 50000}`,
    (i) => `SSL certificate renewal scheduled for domain-${i % 15}.example.com`,
    (i) => `Background job worker_${i % 8} completed batch processing of ${(i % 500) + 50} items`,
    (i) => `Graceful shutdown initiated for instance node-${i % 12}`,
    (i) => `Disk usage warning: partition /data at ${(i % 30) + 70}% capacity`,
    (i) => `Authentication failed for user_${i % 200}: invalid credentials`,
    (i) => `New deployment detected: version v${Math.floor(i / 10000) + 1}.${(i % 100)}.0 rolling out`,
    (i) => `Circuit breaker opened for payment-gateway after ${(i % 5) + 3} consecutive failures`,
    (i) => `Garbage collection pause: ${(i % 200) + 50}ms (young gen)`,
    (i) => `API response sent: status=${[200, 201, 204, 400, 404, 500][i % 6]} latency=${(i % 300) + 5}ms`,
  ];

  // Deterministic PRNG (mulberry32)
  function mulberry32(seed) {
    return function() {
      seed |= 0;
      seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  const rng = mulberry32(42);

  // Generate 30 days of timestamps
  const endDate = new Date('2025-01-30T23:59:59Z');
  const startDate = new Date('2025-01-01T00:00:00Z');
  const timeRange = endDate.getTime() - startDate.getTime();

  console.log(`Seeding ${TOTAL} log entries in batches of ${BATCH_SIZE}...`);
  const seedStart = Date.now();

  for (let batchStart = 0; batchStart < TOTAL; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL);
    const batchCount = batchEnd - batchStart;

    // Build a batch INSERT with parameterized values
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      const r1 = rng();
      const r2 = rng();
      const r3 = rng();
      const r4 = rng();

      // Timestamp: random within 30 day range 
      const ts = new Date(startDate.getTime() + Math.floor(r1 * timeRange));

      // Severity based on distribution
      const sevRoll = r2 * 100;
      let sevIdx = 0;
      for (let s = 0; s < severityThresholds.length; s++) {
        if (sevRoll < severityThresholds[s]) { sevIdx = s; break; }
      }
      const severity = severities[sevIdx];

      // Service
      const service = services[Math.floor(r3 * services.length)];

      // Message
      const templateIdx = Math.floor(r4 * messageTemplates.length);
      const message = messageTemplates[templateIdx](i);

      values.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      params.push(ts.toISOString(), severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',')}`;
    await db.query(sql, params);

    if ((batchStart + BATCH_SIZE) % 10000 === 0 || batchEnd === TOTAL) {
      console.log(`  Seeded ${batchEnd}/${TOTAL} rows (${Date.now() - seedStart}ms elapsed)`);
    }
  }

  console.log(`Seeding complete in ${Date.now() - seedStart}ms`);
}

export async function createIndexes(db) {
  console.log('Creating indexes...');
  const start = Date.now();

  // Index for ordering by timestamp (descending queries)
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC)`);

  // Index for severity + timestamp ordering
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC)`);

  // Trigram index for substring search - PGLite may not support pg_trgm,
  // so we use a B-tree index on lower(message) for prefix matching at least,
  // and rely on indexed ordering + limit for substring scanning
  // Actually, for case-insensitive substring we'll use ILIKE which will seq scan
  // but with the index on ts and limit, it should be fast enough.
  // Let's create a functional index on lower(message) to help with text search
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_message_lower ON logs (lower(message) text_pattern_ops)`);

  console.log(`Indexes created in ${Date.now() - start}ms`);
}
