// Deterministic seeding of 100,000 log entries
// Uses a simple mulberry32 PRNG for determinism

function mulberry32(seed) {
  return function() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'payment-service',
  'notification-service',
  'order-service',
  'inventory-service',
  'analytics-service'
];

// Severity distribution: debug ~60%, info ~25%, warn ~10%, error ~5%
const SEVERITY_THRESHOLDS = [
  { severity: 'debug', cumulative: 0.60 },
  { severity: 'info',  cumulative: 0.85 },
  { severity: 'warn',  cumulative: 0.95 },
  { severity: 'error', cumulative: 1.00 }
];

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // Common/non-selective messages
  (rng) => `Processing request from client ${Math.floor(rng() * 1000)}`,
  (rng) => `Request completed successfully in ${Math.floor(rng() * 500)}ms`,
  (rng) => `Cache hit for key user:${Math.floor(rng() * 10000)}`,
  (rng) => `Cache miss for key session:${Math.floor(rng() * 10000)}`,
  (rng) => `Database query executed in ${Math.floor(rng() * 200)}ms`,
  (rng) => `Health check passed with status OK`,
  (rng) => `Connection pool size: ${Math.floor(rng() * 50) + 1} active`,
  (rng) => `Incoming HTTP ${['GET', 'POST', 'PUT', 'DELETE'][Math.floor(rng() * 4)]} request to /api/v1/resource/${Math.floor(rng() * 100)}`,
  (rng) => `Response sent with status ${[200, 201, 204, 301, 302][Math.floor(rng() * 5)]}`,
  (rng) => `Heartbeat signal received from node-${Math.floor(rng() * 20)}`,
  // Medium-selectivity messages
  (rng) => `Authentication token validated for user_${Math.floor(rng() * 5000)}`,
  (rng) => `Rate limit check: ${Math.floor(rng() * 100)}/100 requests used`,
  (rng) => `Message queued for delivery to channel #${Math.floor(rng() * 50)}`,
  (rng) => `Retry attempt ${Math.floor(rng() * 5) + 1} for operation batch-${Math.floor(rng() * 1000)}`,
  (rng) => `Configuration reloaded: ${Math.floor(rng() * 10)} keys updated`,
  // Selective/rare messages
  (rng) => `CRITICAL: Circuit breaker tripped for downstream service-${Math.floor(rng() * 8)}`,
  (rng) => `ALERT: Memory usage at ${Math.floor(rng() * 20) + 80}% threshold exceeded`,
  (rng) => `FATAL: Unhandled exception in worker thread #${Math.floor(rng() * 4)}`,
  (rng) => `WARNING: SSL certificate expiring in ${Math.floor(rng() * 30) + 1} days`,
  (rng) => `SECURITY: Suspicious login attempt from IP 192.168.${Math.floor(rng() * 255)}.${Math.floor(rng() * 255)}`
];

function pickSeverity(rng) {
  const r = rng();
  for (const { severity, cumulative } of SEVERITY_THRESHOLDS) {
    if (r < cumulative) return severity;
  }
  return 'error';
}

export async function seedLogs(db) {
  const TOTAL = 100000;
  const BATCH_SIZE = 1000;
  const rng = mulberry32(42); // deterministic seed

  // 30 days span ending at a fixed point
  const endTs = new Date('2025-01-15T00:00:00Z').getTime();
  const startTs = endTs - (30 * 24 * 60 * 60 * 1000);
  const range = endTs - startTs;

  console.log(`Seeding ${TOTAL} log entries in batches of ${BATCH_SIZE}...`);
  const seedStart = Date.now();

  // Generate all timestamps first and sort them for realistic ordering
  const timestamps = [];
  for (let i = 0; i < TOTAL; i++) {
    timestamps.push(startTs + Math.floor(rng() * range));
  }
  timestamps.sort((a, b) => a - b);

  // Re-seed RNG for deterministic content generation
  const contentRng = mulberry32(12345);

  for (let batch = 0; batch < TOTAL; batch += BATCH_SIZE) {
    const batchEnd = Math.min(batch + BATCH_SIZE, TOTAL);
    const batchSize = batchEnd - batch;

    // Build a multi-row INSERT with parameterized values
    const placeholders = [];
    const values = [];
    let paramIdx = 1;

    for (let i = batch; i < batchEnd; i++) {
      const ts = new Date(timestamps[i]).toISOString();
      const severity = pickSeverity(contentRng);
      const service = SERVICES[Math.floor(contentRng() * SERVICES.length)];
      const templateIdx = Math.floor(contentRng() * MESSAGE_TEMPLATES.length);
      const message = MESSAGE_TEMPLATES[templateIdx](contentRng);

      placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
      values.push(ts, severity, service, message);
      paramIdx += 4;
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders.join(', ')}`;
    await db.query(sql, values);

    if ((batch + BATCH_SIZE) % 10000 === 0 || batchEnd === TOTAL) {
      console.log(`  Seeded ${batchEnd} / ${TOTAL} rows...`);
    }
  }

  const elapsed = ((Date.now() - seedStart) / 1000).toFixed(1);
  console.log(`Seeding complete in ${elapsed}s`);
}
