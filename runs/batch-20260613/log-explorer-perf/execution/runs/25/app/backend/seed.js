// Deterministic seed data generation for 100,000 log entries
// Uses a simple seeded PRNG for reproducibility

const TOTAL_ROWS = 100_000;
const NUM_DAYS = 30;
const BATCH_SIZE = 1000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'analytics-service',
];

// Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { severity: 'debug', weight: 60 },
  { severity: 'info', weight: 25 },
  { severity: 'warn', weight: 10 },
  { severity: 'error', weight: 5 },
];

const SEVERITY_CUMULATIVE = [];
let cumSum = 0;
for (const s of SEVERITY_WEIGHTS) {
  cumSum += s.weight;
  SEVERITY_CUMULATIVE.push({ severity: s.severity, threshold: cumSum });
}

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // Non-selective (common) terms: "request", "processing", "completed"
  (svc, id) => `Incoming request ${id} to ${svc} endpoint`,
  (svc, id) => `Processing request ${id} in ${svc}`,
  (svc, id) => `Request ${id} completed successfully in ${svc}`,
  (svc, id) => `Response sent for request ${id} from ${svc}`,
  (svc, id) => `Connection established to ${svc} downstream`,
  (svc, id) => `Health check passed for ${svc} instance`,
  (svc, id) => `Cache hit for request ${id} in ${svc}`,
  (svc, id) => `Cache miss for request ${id} in ${svc}, fetching from database`,
  // Selective (rare) terms: "circuit breaker", "deadlock", "out of memory"
  (svc, id) => `Circuit breaker tripped for ${svc} after request ${id}`,
  (svc, id) => `Deadlock detected in ${svc} during transaction ${id}`,
  (svc, id) => `Out of memory warning in ${svc} process ${id}`,
  (svc, id) => `Rate limit exceeded for ${svc} client ${id}`,
  (svc, id) => `TLS handshake failed for ${svc} connection ${id}`,
  (svc, id) => `Retry attempt ${id} for ${svc} upstream call`,
  (svc, id) => `Timeout waiting for ${svc} response on request ${id}`,
  (svc, id) => `Database connection pool exhausted in ${svc} for query ${id}`,
  (svc, id) => `Malformed payload received by ${svc} in request ${id}`,
  (svc, id) => `Authentication token expired for ${svc} session ${id}`,
  (svc, id) => `Configuration reload triggered for ${svc} version ${id}`,
  (svc, id) => `Graceful shutdown initiated for ${svc} instance ${id}`,
];

// Simple seeded PRNG (mulberry32)
function createRng(seed) {
  let s = seed | 0;
  return function () {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickSeverity(rng) {
  const r = rng() * 100;
  for (const { severity, threshold } of SEVERITY_CUMULATIVE) {
    if (r < threshold) return severity;
  }
  return 'debug';
}

function generateRows() {
  const rng = createRng(42);
  const rows = [];

  // Base timestamp: 30 days ago from a fixed epoch (2025-01-01T00:00:00Z)
  const baseTs = new Date('2025-01-01T00:00:00Z').getTime();
  const rangeMs = NUM_DAYS * 24 * 60 * 60 * 1000;

  for (let i = 0; i < TOTAL_ROWS; i++) {
    const tsOffset = rng() * rangeMs;
    const ts = new Date(baseTs + tsOffset);
    const severity = pickSeverity(rng);
    const service = SERVICES[Math.floor(rng() * SERVICES.length)];
    const templateIdx = Math.floor(rng() * MESSAGE_TEMPLATES.length);
    const requestId = Math.floor(rng() * 1_000_000);
    const message = MESSAGE_TEMPLATES[templateIdx](service, requestId);

    rows.push({ ts, severity, service, message });
  }

  return rows;
}

function generateBatchValues(rows, startIdx, batchSize) {
  const end = Math.min(startIdx + batchSize, rows.length);
  const params = [];
  const placeholders = [];
  let paramIdx = 1;

  for (let i = startIdx; i < end; i++) {
    const row = rows[i];
    placeholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3})`);
    params.push(row.ts.toISOString(), row.severity, row.service, row.message);
    paramIdx += 4;
  }

  return {
    sql: `INSERT INTO logs (ts, severity, service, message) VALUES ${placeholders.join(', ')}`,
    params,
    count: end - startIdx,
  };
}

module.exports = { generateRows, generateBatchValues, TOTAL_ROWS, BATCH_SIZE };
