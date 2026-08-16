/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for full reproducibility.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2000;

// LCG parameters (Numerical Recipes)
const LCG_A = 1664525n;
const LCG_C = 1013904223n;
const LCG_M = 2n ** 32n;

function makePrng(seed) {
  let state = BigInt(seed);
  return function () {
    state = (LCG_A * state + LCG_C) % LCG_M;
    return Number(state) / Number(LCG_M); // [0, 1)
  };
}

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

// Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [0.60, 0.85, 0.95, 1.0];
const SEVERITIES = ['debug', 'info', 'warn', 'error'];

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // debug templates
  (r) => `Processing request ${Math.floor(r() * 1e9)} for user ${Math.floor(r() * 1e6)}`,
  (r) => `Cache ${r() > 0.5 ? 'hit' : 'miss'} for key session_${Math.floor(r() * 1e7)}`,
  (r) => `Database query executed in ${Math.floor(r() * 500)}ms on table ${['users','orders','products','sessions'][Math.floor(r() * 4)]}`,
  (r) => `Heartbeat check passed for node-${Math.floor(r() * 20)}`,
  (r) => `Config loaded: timeout=${Math.floor(r() * 30000)}ms retries=${Math.floor(r() * 5)}`,
  (r) => `Span ${Math.floor(r() * 1e12).toString(16)} started for operation ${['read','write','delete','update'][Math.floor(r() * 4)]}`,
  (r) => `Token validated for subject sub_${Math.floor(r() * 1e8)}`,
  (r) => `Queue depth is ${Math.floor(r() * 10000)} messages on channel ${['events','commands','notifications'][Math.floor(r() * 3)]}`,
  // info templates
  (r) => `User ${Math.floor(r() * 1e6)} logged in from IP 10.${Math.floor(r()*255)}.${Math.floor(r()*255)}.${Math.floor(r()*255)}`,
  (r) => `Order ${Math.floor(r() * 1e8)} created with ${Math.floor(r() * 50) + 1} items totaling $${(r() * 10000).toFixed(2)}`,
  (r) => `Payment ${r() > 0.1 ? 'succeeded' : 'failed'} for order ${Math.floor(r() * 1e8)} amount $${(r() * 5000).toFixed(2)}`,
  (r) => `Email notification sent to user_${Math.floor(r() * 1e6)} template=${['welcome','reset','invoice','alert'][Math.floor(r() * 4)]}`,
  (r) => `Search query "${['error','timeout','payment','login','user','order','product','session'][Math.floor(r() * 8)]}" returned ${Math.floor(r() * 1000)} results`,
  (r) => `Service ${SERVICES[Math.floor(r() * SERVICES.length)]} health check OK latency=${Math.floor(r() * 100)}ms`,
  (r) => `Inventory updated for product_${Math.floor(r() * 1e5)} delta=${Math.floor(r() * 200) - 100}`,
  (r) => `Analytics event tracked: ${['page_view','click','purchase','signup','logout'][Math.floor(r() * 5)]} user=${Math.floor(r() * 1e6)}`,
  // warn templates
  (r) => `Slow query detected: ${Math.floor(r() * 5000) + 1000}ms on table ${['users','orders','products'][Math.floor(r() * 3)]}`,
  (r) => `Rate limit approaching for client ${Math.floor(r() * 1e5)}: ${Math.floor(r() * 100) + 80}% of quota used`,
  (r) => `Retry attempt ${Math.floor(r() * 5) + 1} for request to ${SERVICES[Math.floor(r() * SERVICES.length)]}`,
  (r) => `Memory usage high: ${Math.floor(r() * 30) + 70}% on node-${Math.floor(r() * 20)}`,
  (r) => `Deprecated API endpoint /v1/${['users','orders','auth'][Math.floor(r() * 3)]} called by client_${Math.floor(r() * 1e4)}`,
  (r) => `Connection pool exhausted: waiting ${Math.floor(r() * 5000)}ms for available connection`,
  // error templates
  (r) => `Unhandled exception in ${SERVICES[Math.floor(r() * SERVICES.length)]}: ${['NullPointerException','TimeoutError','ConnectionRefused','OutOfMemoryError'][Math.floor(r() * 4)]}`,
  (r) => `Authentication failed for user ${Math.floor(r() * 1e6)}: invalid token`,
  (r) => `Database connection lost: ${['primary','replica'][Math.floor(r() * 2)]} host unreachable after ${Math.floor(r() * 30)}s`,
  (r) => `Payment gateway timeout for order ${Math.floor(r() * 1e8)} after ${Math.floor(r() * 30000)}ms`,
];

// Selective terms (appear in ~1-5% of messages): 'NullPointerException', 'OutOfMemoryError', 'gateway timeout'
// Non-selective terms (appear in ~50%+ of messages): 'user', 'order', 'service'

function pickSeverity(rand) {
  const v = rand();
  for (let i = 0; i < SEVERITY_THRESHOLDS.length; i++) {
    if (v < SEVERITY_THRESHOLDS[i]) return SEVERITIES[i];
  }
  return 'debug';
}

function pickTemplate(severity, rand) {
  // debug: 0-7, info: 8-15, warn: 16-21, error: 22-25
  const ranges = { debug: [0, 8], info: [8, 16], warn: [16, 22], error: [22, 26] };
  const [start, end] = ranges[severity];
  const idx = start + Math.floor(rand() * (end - start));
  return MESSAGE_TEMPLATES[idx];
}

export function generateRows() {
  const rand = makePrng(42);
  // Base timestamp: 30 days ago from a fixed reference point
  const BASE_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  const rows = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsOffset = rand() * SPAN_MS;
    const ts = new Date(BASE_TS + tsOffset).toISOString();
    const severity = pickSeverity(rand);
    const service = SERVICES[Math.floor(rand() * SERVICES.length)];
    const template = pickTemplate(severity, rand);
    const message = template(rand);
    rows.push({ ts, severity, service, message });
  }
  return rows;
}

export async function seedDatabase(db) {
  console.log('Starting database seed...');
  const startTime = Date.now();

  // Create table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id        SERIAL PRIMARY KEY,
      ts        TIMESTAMPTZ NOT NULL,
      severity  TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
      service   TEXT NOT NULL,
      message   TEXT NOT NULL
    );
  `);

  // Check if already seeded
  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= TOTAL_ROWS) {
    console.log(`Database already seeded with ${existingCount} rows. Skipping.`);
    await createIndexes(db);
    // Run ANALYZE to ensure query planner has up-to-date statistics
    await db.exec('ANALYZE logs;');
    return;
  }

  if (existingCount > 0) {
    console.log(`Partial seed detected (${existingCount} rows). Truncating and reseeding...`);
    await db.exec('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log(`Generating ${TOTAL_ROWS} rows...`);
  const rows = generateRows();

  console.log(`Inserting in batches of ${BATCH_SIZE}...`);
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const values = batch.map((_, j) => {
      const base = j * 4;
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`;
    }).join(', ');

    const params = batch.flatMap(r => [r.ts, r.severity, r.service, r.message]);
    await db.query(
      `INSERT INTO logs (ts, severity, service, message) VALUES ${values}`,
      params
    );

    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`  Inserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${TOTAL_ROWS} rows...`);
    }
  }

  console.log('Creating indexes...');
  await createIndexes(db);

  console.log('Running ANALYZE to update query planner statistics...');
  await db.exec('ANALYZE logs;');
  console.log('ANALYZE complete.');

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Seed complete in ${elapsed}s`);
}

async function createIndexes(db) {
  // Index for ordering by ts (most common query shape)
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs (ts DESC);
  `);

  // Index for severity filter + ts ordering
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_logs_severity_ts ON logs (severity, ts DESC);
  `);

  // For substring search on message, use pg_trgm for fast ILIKE
  // PGLite supports pg_trgm extension
  try {
    await db.exec(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await db.exec(`
      CREATE INDEX IF NOT EXISTS idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
    `);
    console.log('pg_trgm extension and trigram index created.');
  } catch (e) {
    console.warn('pg_trgm not available, falling back to no trigram index:', e.message);
    // Fallback: just ensure we have the ts index for ordering
  }

  console.log('Indexes ready.');
}
