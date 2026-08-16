/**
 * Deterministic seed of 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for full reproducibility.
 * Batches inserts for speed.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

// Severities with approximate distribution: 60% info, 25% debug, 10% warn, 5% error
const SEVERITIES = [
  ...Array(60).fill('info'),
  ...Array(25).fill('debug'),
  ...Array(10).fill('warn'),
  ...Array(5).fill('error'),
];

const SERVICES = [
  'auth-service',
  'api-gateway',
  'user-service',
  'payment-service',
  'notification-service',
  'search-service',
  'analytics-service',
  'storage-service',
];

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  (r) => `Request received from ${ipAddr(r)} for endpoint ${endpoint(r)}`,
  (r) => `User ${userId(r)} authenticated successfully via ${authMethod(r)}`,
  (r) => `Database query completed in ${queryTime(r)}ms for table ${tableName(r)}`,
  (r) => `Cache ${cacheOp(r)} for key ${cacheKey(r)} in ${cacheTime(r)}ms`,
  (r) => `Payment processed for order ${orderId(r)} amount $${amount(r)}`,
  (r) => `File ${fileOp(r)} completed: ${filename(r)} (${fileSize(r)} bytes)`,
  (r) => `Health check passed for service ${serviceName(r)} at ${endpoint(r)}`,
  (r) => `Rate limit ${rateLimitAction(r)} for client ${ipAddr(r)} on route ${endpoint(r)}`,
  (r) => `Session ${sessionOp(r)} for user ${userId(r)} token ${token(r)}`,
  (r) => `Notification ${notifType(r)} sent to user ${userId(r)} via ${notifChannel(r)}`,
  (r) => `Search query "${searchTerm(r)}" returned ${searchCount(r)} results in ${queryTime(r)}ms`,
  (r) => `Configuration ${configOp(r)} for key ${configKey(r)} value updated`,
  (r) => `Retry attempt ${retryNum(r)} for job ${jobId(r)} after ${retryDelay(r)}ms`,
  (r) => `Connection ${connOp(r)} to ${dbHost(r)} pool size ${poolSize(r)}`,
  (r) => `Webhook ${webhookOp(r)} to ${webhookUrl(r)} status ${httpStatus(r)}`,
  (r) => `Batch job ${jobId(r)} processed ${batchCount(r)} records in ${queryTime(r)}ms`,
  (r) => `Token ${tokenOp(r)} for user ${userId(r)} expires in ${expiry(r)}s`,
  (r) => `Middleware ${middlewareName(r)} executed in ${queryTime(r)}ms for ${endpoint(r)}`,
  (r) => `Error recovered: ${errorCode(r)} on ${endpoint(r)} after ${retryNum(r)} retries`,
  (r) => `Audit log: user ${userId(r)} performed ${auditAction(r)} on resource ${resourceId(r)}`,
];

// Fragment generators
function ipAddr(r) {
  return `${10 + (r.next() % 240)}.${r.next() % 256}.${r.next() % 256}.${r.next() % 256}`;
}
function endpoint(r) {
  const paths = ['/api/v1/users', '/api/v1/orders', '/api/v1/products', '/api/v2/search',
    '/api/v1/auth/login', '/api/v1/auth/logout', '/api/v1/payments', '/health',
    '/api/v1/notifications', '/api/v1/files', '/api/v1/sessions', '/api/v1/config'];
  return paths[r.next() % paths.length];
}
function userId(r) { return `usr_${(r.next() % 99999 + 1).toString().padStart(5, '0')}`; }
function authMethod(r) {
  return ['password', 'oauth2', 'saml', 'api-key', 'jwt'][r.next() % 5];
}
function queryTime(r) { return (r.next() % 500 + 1); }
function tableName(r) {
  return ['users', 'orders', 'products', 'sessions', 'payments', 'notifications'][r.next() % 6];
}
function cacheOp(r) { return ['hit', 'miss', 'set', 'evict', 'invalidate'][r.next() % 5]; }
function cacheKey(r) { return `cache:${['user', 'order', 'product', 'session'][r.next() % 4]}:${r.next() % 9999}`; }
function cacheTime(r) { return r.next() % 50 + 1; }
function orderId(r) { return `ord_${(r.next() % 999999 + 1).toString().padStart(6, '0')}`; }
function amount(r) { return ((r.next() % 100000) / 100).toFixed(2); }
function fileOp(r) { return ['upload', 'download', 'delete', 'copy', 'move'][r.next() % 5]; }
function filename(r) {
  const names = ['report', 'invoice', 'export', 'backup', 'archive', 'log'];
  const exts = ['.pdf', '.csv', '.json', '.zip', '.tar.gz'];
  return `${names[r.next() % names.length]}_${r.next() % 9999}${exts[r.next() % exts.length]}`;
}
function fileSize(r) { return r.next() % 10000000 + 100; }
function serviceName(r) { return SERVICES[r.next() % SERVICES.length]; }
function rateLimitAction(r) { return ['exceeded', 'warning', 'reset'][r.next() % 3]; }
function sessionOp(r) { return ['created', 'refreshed', 'expired', 'invalidated'][r.next() % 4]; }
function token(r) { return `tok_${(r.next() % 0xffffff).toString(16).padStart(6, '0')}`; }
function notifType(r) { return ['email', 'sms', 'push', 'webhook'][r.next() % 4]; }
function notifChannel(r) { return ['sendgrid', 'twilio', 'firebase', 'slack'][r.next() % 4]; }
function searchTerm(r) {
  // Mix of selective (rare) and non-selective (common) terms
  const terms = ['payment', 'error', 'timeout', 'authentication', 'database',
    'xk9z', 'qwerty', 'foobar', 'zebra', 'alpha', 'connection', 'retry',
    'cache', 'session', 'token', 'webhook', 'batch', 'config', 'audit', 'rate'];
  return terms[r.next() % terms.length];
}
function searchCount(r) { return r.next() % 1000; }
function configOp(r) { return ['read', 'write', 'delete', 'reload'][r.next() % 4]; }
function configKey(r) {
  return ['max_connections', 'timeout_ms', 'retry_limit', 'cache_ttl', 'rate_limit'][r.next() % 5];
}
function retryNum(r) { return r.next() % 5 + 1; }
function retryDelay(r) { return (r.next() % 10 + 1) * 100; }
function jobId(r) { return `job_${(r.next() % 99999 + 1).toString().padStart(5, '0')}`; }
function connOp(r) { return ['opened', 'closed', 'reset', 'timeout', 'pooled'][r.next() % 5]; }
function dbHost(r) { return [`db-primary`, `db-replica-${r.next() % 3 + 1}`, 'db-analytics'][r.next() % 3]; }
function poolSize(r) { return r.next() % 50 + 5; }
function webhookOp(r) { return ['delivered', 'failed', 'retried', 'queued'][r.next() % 4]; }
function webhookUrl(r) {
  return `https://hooks.example${r.next() % 10}.com/webhook/${r.next() % 999}`;
}
function httpStatus(r) { return [200, 201, 400, 401, 403, 404, 429, 500, 502, 503][r.next() % 10]; }
function batchCount(r) { return r.next() % 10000 + 1; }
function tokenOp(r) { return ['issued', 'refreshed', 'revoked', 'validated'][r.next() % 4]; }
function expiry(r) { return [300, 900, 3600, 86400][r.next() % 4]; }
function middlewareName(r) {
  return ['auth', 'rateLimit', 'cors', 'logging', 'compression', 'validation'][r.next() % 6];
}
function errorCode(r) {
  return ['ERR_TIMEOUT', 'ERR_CONN_REFUSED', 'ERR_NOT_FOUND', 'ERR_UNAUTHORIZED', 'ERR_INTERNAL'][r.next() % 5];
}
function auditAction(r) {
  return ['create', 'update', 'delete', 'view', 'export', 'import'][r.next() % 6];
}
function resourceId(r) { return `res_${(r.next() % 99999 + 1).toString().padStart(5, '0')}`; }

/**
 * Simple LCG PRNG — deterministic, fast, no external deps.
 * Parameters from Numerical Recipes.
 */
class LCG {
  constructor(seed) {
    this.state = BigInt(seed) & 0xffffffffn;
  }
  next() {
    this.state = (1664525n * this.state + 1013904223n) & 0xffffffffn;
    return Number(this.state);
  }
}

export async function seed(db, startFrom = 0) {
  const rng = new LCG(42);

  // Advance RNG to startFrom position (skip already-generated rows)
  // Each row consumes a variable number of RNG calls; simplest is to regenerate from 0
  // and skip insertion for rows < startFrom.
  // For simplicity and correctness, always regenerate from scratch.

  // Time span: 30 days ending at a fixed point
  const END_TS = new Date('2024-01-31T23:59:59Z').getTime();
  const START_TS = END_TS - 30 * 24 * 60 * 60 * 1000;
  const TS_RANGE = END_TS - START_TS;

  // Pre-generate all row data, then batch insert
  // We'll stream batches to avoid holding 100k rows in memory at once

  let rowsInserted = 0;

  for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = batchStart; i < batchEnd; i++) {
      const id = i + 1;
      // Deterministic timestamp spread across 30 days
      const tsOffset = Math.floor((rng.next() / 0xffffffff) * TS_RANGE);
      const ts = new Date(START_TS + tsOffset).toISOString();
      const severity = SEVERITIES[rng.next() % SEVERITIES.length];
      const service = SERVICES[rng.next() % SERVICES.length];
      const templateIdx = rng.next() % MESSAGE_TEMPLATES.length;
      const message = MESSAGE_TEMPLATES[templateIdx](rng);

      rows.push({ id, ts, severity, service, message });
    }

    // Skip rows already in DB
    if (batchEnd <= startFrom) {
      continue;
    }

    const insertRows = startFrom > batchStart
      ? rows.slice(startFrom - batchStart)
      : rows;

    if (insertRows.length === 0) continue;

    // Build a single multi-row INSERT
    const valuePlaceholders = [];
    const params = [];
    let paramIdx = 1;

    for (const row of insertRows) {
      valuePlaceholders.push(`($${paramIdx}, $${paramIdx + 1}::timestamptz, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
      paramIdx += 5;
    }

    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')} ON CONFLICT (id) DO NOTHING`;
    await db.query(sql, params);

    rowsInserted += insertRows.length;
    if (rowsInserted % 10000 === 0 || batchEnd === TOTAL_ROWS) {
      console.log(`[seed] Inserted ${rowsInserted} rows...`);
    }
  }

  console.log(`[seed] Done. Total inserted: ${rowsInserted}`);
}
