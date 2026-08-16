// Deterministic seed for 100,000 log entries
// Uses a simple seeded PRNG for reproducibility

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'inventory-service',
  'analytics-service'
];

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 }
];

const SEVERITY_CUMULATIVE = [];
let cumWeight = 0;
for (const sw of SEVERITY_WEIGHTS) {
  cumWeight += sw.weight;
  SEVERITY_CUMULATIVE.push({ severity: sw.severity, threshold: cumWeight });
}

function pickSeverity(rand) {
  const val = rand() * 100;
  for (const s of SEVERITY_CUMULATIVE) {
    if (val < s.threshold) return s.severity;
  }
  return 'debug';
}

// Message templates with variable fragments
// Mix of selective (rare) and non-selective (common) terms
const MESSAGE_TEMPLATES = [
  // Common/non-selective patterns
  (rand, service) => `Processing request for ${service} endpoint`,
  (rand, service) => `Request completed successfully in ${Math.floor(rand() * 500) + 10}ms`,
  (rand, service) => `Handling incoming connection from ${pickIP(rand)}`,
  (rand, service) => `Cache hit for key session:${Math.floor(rand() * 10000)}`,
  (rand, service) => `Cache miss for key user:${Math.floor(rand() * 10000)}`,
  (rand, service) => `Database query executed in ${Math.floor(rand() * 200) + 1}ms`,
  (rand, service) => `Health check passed for ${service}`,
  (rand, service) => `Configuration loaded from environment`,
  (rand, service) => `Starting background job worker-${Math.floor(rand() * 100)}`,
  (rand, service) => `Received message on queue events.${service}`,

  // Medium selectivity
  (rand, service) => `Retrying failed operation attempt ${Math.floor(rand() * 5) + 1} of 5`,
  (rand, service) => `Rate limit threshold reached for client ${pickClientId(rand)}`,
  (rand, service) => `Slow query detected: ${Math.floor(rand() * 5000) + 1000}ms on table users`,
  (rand, service) => `Memory usage at ${Math.floor(rand() * 40) + 60}% for ${service}`,
  (rand, service) => `WebSocket connection established from ${pickIP(rand)}`,
  (rand, service) => `JWT token validated for user ${Math.floor(rand() * 50000)}`,
  (rand, service) => `Batch processing ${Math.floor(rand() * 1000) + 100} items`,
  (rand, service) => `Deploying version ${Math.floor(rand() * 100)}.${Math.floor(rand() * 100)}.${Math.floor(rand() * 100)}`,

  // Selective/rare patterns
  (rand, service) => `CRITICAL: Disk space below 5% on volume /data`,
  (rand, service) => `Circuit breaker OPEN for downstream ${SERVICES[Math.floor(rand() * SERVICES.length)]}`,
  (rand, service) => `Unhandled exception in request pipeline: NullPointerException`,
  (rand, service) => `SSL certificate expiring in ${Math.floor(rand() * 30) + 1} days`,
  (rand, service) => `Deadlock detected in transaction ${Math.floor(rand() * 999999)}`,
  (rand, service) => `Failover triggered: switching to replica database`,
  (rand, service) => `SECURITY: Brute force attempt detected from ${pickIP(rand)}`,
  (rand, service) => `Data corruption detected in partition ${Math.floor(rand() * 16)}`
];

function pickIP(rand) {
  return `${Math.floor(rand() * 255) + 1}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 256)}.${Math.floor(rand() * 255) + 1}`;
}

function pickClientId(rand) {
  const prefixes = ['client', 'app', 'svc', 'bot'];
  return `${prefixes[Math.floor(rand() * prefixes.length)]}-${Math.floor(rand() * 1000)}`;
}

export async function seedDatabase(db) {
  const TOTAL_ROWS = 100000;
  const BATCH_SIZE = 2000;
  const rand = mulberry32(42); // deterministic seed

  // 30 days timespan, ending "now" (fixed point for determinism)
  const END_TS = new Date('2025-06-01T00:00:00Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;

  console.time('seed');
  console.log(`Seeding ${TOTAL_ROWS} log entries...`);

  // Generate all timestamps first and sort descending for natural ordering
  const timestamps = [];
  for (let i = 0; i < TOTAL_ROWS; i++) {
    timestamps.push(START_TS + Math.floor(rand() * (END_TS - START_TS)));
  }
  timestamps.sort((a, b) => a - b); // ascending for insertion

  // Re-seed for other fields so it's deterministic
  const rand2 = mulberry32(123);

  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);
    const batchSize = batchEnd - inserted;

    // Build batch INSERT using VALUES with parameter placeholders
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (let i = inserted; i < batchEnd; i++) {
      const ts = new Date(timestamps[i]).toISOString();
      const severity = pickSeverity(rand2);
      const service = SERVICES[Math.floor(rand2() * SERVICES.length)];
      const templateIdx = Math.floor(rand2() * MESSAGE_TEMPLATES.length);
      const message = MESSAGE_TEMPLATES[templateIdx](rand2, service);

      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(ts, severity, service, message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    inserted = batchEnd;
    if (inserted % 20000 === 0 || inserted === TOTAL_ROWS) {
      console.log(`  Seeded ${inserted}/${TOTAL_ROWS} rows`);
    }
  }

  console.timeEnd('seed');
}
