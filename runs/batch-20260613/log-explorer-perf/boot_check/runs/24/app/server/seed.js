// Deterministic seed for 100,000 log entries

// Simple seeded PRNG (mulberry32)
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'order-service',
  'inventory-service'
];

// Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'info', weight: 60 },
  { severity: 'debug', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 }
];

const TOTAL_WEIGHT = SEVERITY_WEIGHTS.reduce((s, w) => s + w.weight, 0);

function pickSeverity(rand) {
  const r = rand() * TOTAL_WEIGHT;
  let cumulative = 0;
  for (const sw of SEVERITY_WEIGHTS) {
    cumulative += sw.weight;
    if (r < cumulative) return sw.severity;
  }
  return 'info';
}

// Message templates with variable fragments
// Some terms are selective (rare), some are non-selective (common)
const MESSAGE_TEMPLATES = [
  // Common/non-selective patterns
  (rand, service) => `Request processed successfully in ${Math.floor(rand() * 500)}ms`,
  (rand, service) => `Handling incoming request from client ${Math.floor(rand() * 1000)}`,
  (rand, service) => `Connection established to ${service} backend`,
  (rand, service) => `Health check passed for ${service}`,
  (rand, service) => `Cache hit for key user:${Math.floor(rand() * 10000)}`,
  (rand, service) => `Cache miss for key session:${Math.floor(rand() * 10000)}`,
  (rand, service) => `Response sent with status ${[200, 201, 204][Math.floor(rand() * 3)]}`,
  (rand, service) => `Processing batch of ${Math.floor(rand() * 100) + 1} items`,
  (rand, service) => `Database query completed in ${Math.floor(rand() * 200)}ms`,
  (rand, service) => `Middleware pipeline executed for route /api/${['users', 'orders', 'products', 'auth'][Math.floor(rand() * 4)]}`,

  // Medium selectivity
  (rand, service) => `Rate limit threshold reached for IP 192.168.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}`,
  (rand, service) => `Retry attempt ${Math.floor(rand() * 5) + 1} for downstream call to ${SERVICES[Math.floor(rand() * SERVICES.length)]}`,
  (rand, service) => `JWT token validated for user_${Math.floor(rand() * 5000)}`,
  (rand, service) => `Webhook delivery to endpoint https://hooks.example.com/${Math.floor(rand() * 100)}`,
  (rand, service) => `Configuration reloaded for ${service} module ${['auth', 'cache', 'db', 'queue'][Math.floor(rand() * 4)]}`,

  // Selective/rare patterns
  (rand, service) => `CRITICAL: Circuit breaker tripped for ${service} after ${Math.floor(rand() * 10) + 3} failures`,
  (rand, service) => `OutOfMemory warning: heap usage at ${Math.floor(rand() * 10) + 90}% in ${service}`,
  (rand, service) => `Deadlock detected in transaction ${Math.floor(rand() * 100000)} on ${service}`,
  (rand, service) => `Schema migration v${Math.floor(rand() * 50) + 1} applied successfully`,
  (rand, service) => `Deployment canary: ${service} version ${Math.floor(rand() * 10)}.${Math.floor(rand() * 100)}.${Math.floor(rand() * 1000)} activated`
];

async function seedLogs(db) {
  const rand = mulberry32(42); // Fixed seed for determinism

  // 30-day time span ending "now" (use a fixed point for determinism)
  const endTime = new Date('2025-06-01T00:00:00Z').getTime();
  const startTime = endTime - 30 * 24 * 60 * 60 * 1000;

  // Generate all timestamps first, then sort descending for natural ordering
  const timestamps = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    const ts = new Date(startTime + rand() * (endTime - startTime));
    timestamps.push(ts);
  }
  timestamps.sort((a, b) => a.getTime() - b.getTime());

  // Re-seed for other fields so they're deterministic regardless of timestamp sort
  const rand2 = mulberry32(12345);

  let inserted = 0;
  const totalBatches = Math.ceil(TOTAL_ROWS / BATCH_SIZE);

  for (let batch = 0; batch < totalBatches; batch++) {
    const batchStart = batch * BATCH_SIZE;
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const batchRows = batchEnd - batchStart;

    // Build bulk INSERT with parameterized values
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = batchStart; i < batchEnd; i++) {
      const ts = timestamps[i].toISOString();
      const severity = pickSeverity(rand2);
      const service = SERVICES[Math.floor(rand2() * SERVICES.length)];
      const templateIdx = Math.floor(rand2() * MESSAGE_TEMPLATES.length);
      const message = MESSAGE_TEMPLATES[templateIdx](rand2, service);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    inserted += batchRows;
    if ((batch + 1) % 10 === 0 || batch === totalBatches - 1) {
      console.log(`[seed] Inserted ${inserted}/${TOTAL_ROWS} rows (${Math.round(inserted / TOTAL_ROWS * 100)}%)`);
    }
  }

  console.log(`[seed] Seeding complete: ${inserted} rows`);
}

module.exports = { seedLogs };
