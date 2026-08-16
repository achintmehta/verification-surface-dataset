/**
 * Deterministic seed: 100,000 log entries spanning 30 days across 8 services.
 * Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments for selective/non-selective search.
 */

const SERVICES = [
  'api-gateway',
  'auth-service',
  'user-service',
  'order-service',
  'payment-service',
  'inventory-service',
  'notification-service',
  'analytics-service',
];

const SEVERITIES = ['debug', 'info', 'info', 'info', 'info', 'info', 'info', 'warn', 'warn', 'error'];
// Rough distribution: debug=10%, info=60%, warn=20%, error=10%
// We'll use a weighted array: indices 0=debug,1-6=info,7-8=warn,9=error

const MESSAGE_TEMPLATES = [
  // info templates (non-selective - common words)
  (v) => `Request received from client ${v.ip} on endpoint ${v.endpoint}`,
  (v) => `Response sent with status ${v.status} in ${v.ms}ms`,
  (v) => `User ${v.userId} authenticated successfully`,
  (v) => `Processing request for resource ${v.resource}`,
  (v) => `Cache hit for key ${v.cacheKey}`,
  (v) => `Cache miss for key ${v.cacheKey}, fetching from database`,
  (v) => `Database query executed in ${v.ms}ms returning ${v.rows} rows`,
  (v) => `Connection established to ${v.host}:${v.port}`,
  (v) => `Health check passed for service ${v.service}`,
  (v) => `Configuration loaded from ${v.configPath}`,
  // debug templates
  (v) => `Debug: entering function ${v.funcName} with args ${v.args}`,
  (v) => `Debug: variable state dump for ${v.varName}: ${v.value}`,
  (v) => `Debug: SQL query plan for table ${v.table}: seq_scan=${v.seqScan}`,
  (v) => `Debug: memory usage at checkpoint ${v.checkpoint}: ${v.memMb}MB`,
  (v) => `Debug: retry attempt ${v.attempt} for operation ${v.operation}`,
  // warn templates
  (v) => `Warning: slow query detected on table ${v.table} took ${v.ms}ms`,
  (v) => `Warning: rate limit approaching for client ${v.clientId} (${v.pct}% used)`,
  (v) => `Warning: disk usage at ${v.pct}% on volume ${v.volume}`,
  (v) => `Warning: deprecated API endpoint ${v.endpoint} called by ${v.clientId}`,
  (v) => `Warning: connection pool exhausted, queuing request for ${v.ms}ms`,
  // error templates (selective - unique words)
  (v) => `Error: NullPointerException in module ${v.module} at line ${v.line}`,
  (v) => `Error: database connection failed after ${v.attempt} retries: ${v.errMsg}`,
  (v) => `Error: authentication token expired for user ${v.userId}`,
  (v) => `Error: payment processing failed for order ${v.orderId}: ${v.errMsg}`,
  (v) => `Error: unhandled exception in worker thread ${v.threadId}: ${v.errMsg}`,
];

const ENDPOINTS = [
  '/api/users', '/api/orders', '/api/products', '/api/auth/login',
  '/api/auth/logout', '/api/payments', '/api/inventory', '/api/analytics',
  '/api/notifications', '/api/health', '/api/config', '/api/search',
];

const RESOURCES = [
  'user-profile', 'order-list', 'product-catalog', 'payment-record',
  'inventory-item', 'notification-queue', 'analytics-report', 'config-map',
];

const CACHE_KEYS = [
  'user:session:', 'product:detail:', 'order:summary:', 'rate:limit:',
  'config:global', 'analytics:daily:', 'inventory:count:', 'auth:token:',
];

const HOSTS = [
  'db-primary.internal', 'db-replica-1.internal', 'cache-1.internal',
  'queue-1.internal', 'storage-1.internal',
];

const VOLUMES = ['/dev/sda1', '/dev/sdb1', '/dev/sdc1', '/mnt/data'];

const ERROR_MESSAGES = [
  'connection refused', 'timeout exceeded', 'permission denied',
  'resource not found', 'invalid credentials', 'quota exceeded',
  'network unreachable', 'service unavailable',
];

const FUNC_NAMES = [
  'processRequest', 'validateToken', 'fetchUserData', 'computeTotal',
  'updateInventory', 'sendNotification', 'aggregateMetrics', 'parseConfig',
];

const TABLES = [
  'users', 'orders', 'products', 'payments', 'inventory', 'sessions', 'events',
];

const MODULES = [
  'RequestHandler', 'AuthMiddleware', 'DatabasePool', 'CacheManager',
  'PaymentProcessor', 'NotificationWorker', 'AnalyticsEngine',
];

// Simple deterministic pseudo-random number generator (LCG)
function createRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function randInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function randIp(rng) {
  return `${randInt(rng, 10, 192)}.${randInt(rng, 0, 255)}.${randInt(rng, 0, 255)}.${randInt(rng, 1, 254)}`;
}

export function generateRows(count = 100000) {
  const rng = createRng(0xdeadbeef);

  // Base timestamp: 30 days ago from a fixed reference point for determinism
  const BASE_TS = new Date('2024-01-01T00:00:00.000Z').getTime();
  const RANGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  const rows = [];

  for (let i = 0; i < count; i++) {
    // Deterministic timestamp spread across 30 days
    const tsOffset = Math.floor(rng() * RANGE_MS);
    const ts = new Date(BASE_TS + tsOffset).toISOString();

    // Severity with weighted distribution
    const sevIdx = Math.floor(rng() * 10);
    const severity = SEVERITIES[sevIdx];

    // Service
    const service = pick(rng, SERVICES);

    // Pick template based on severity
    let templateIdx;
    if (severity === 'debug') {
      templateIdx = 10 + Math.floor(rng() * 5);
    } else if (severity === 'info') {
      templateIdx = Math.floor(rng() * 10);
    } else if (severity === 'warn') {
      templateIdx = 15 + Math.floor(rng() * 5);
    } else {
      templateIdx = 20 + Math.floor(rng() * 5);
    }

    const template = MESSAGE_TEMPLATES[templateIdx];

    // Build variable fragments
    const vars = {
      ip: randIp(rng),
      endpoint: pick(rng, ENDPOINTS),
      status: pick(rng, [200, 201, 204, 400, 401, 403, 404, 500]),
      ms: randInt(rng, 1, 5000),
      userId: `usr_${randInt(rng, 1000, 9999)}`,
      resource: pick(rng, RESOURCES),
      cacheKey: pick(rng, CACHE_KEYS) + randInt(rng, 1, 999),
      rows: randInt(rng, 0, 10000),
      host: pick(rng, HOSTS),
      port: pick(rng, [5432, 6379, 5672, 9200, 3306]),
      configPath: `/etc/config/${service}.yaml`,
      funcName: pick(rng, FUNC_NAMES),
      args: `[${randInt(rng, 1, 100)}, "${pick(rng, RESOURCES)}"]`,
      varName: `${pick(rng, ['req', 'res', 'ctx', 'data', 'result'])}`,
      value: `{id:${randInt(rng, 1, 9999)}}`,
      table: pick(rng, TABLES),
      seqScan: pick(rng, ['true', 'false']),
      checkpoint: `cp_${randInt(rng, 1, 100)}`,
      memMb: randInt(rng, 64, 4096),
      attempt: randInt(rng, 1, 5),
      operation: pick(rng, ['db-write', 'cache-set', 'api-call', 'file-write']),
      clientId: `client_${randInt(rng, 100, 999)}`,
      pct: randInt(rng, 70, 99),
      volume: pick(rng, VOLUMES),
      module: pick(rng, MODULES),
      line: randInt(rng, 1, 500),
      errMsg: pick(rng, ERROR_MESSAGES),
      orderId: `ord_${randInt(rng, 10000, 99999)}`,
      threadId: randInt(rng, 1, 32),
      service: service,
    };

    const message = template(vars);

    rows.push({ ts, severity, service, message });
  }

  return rows;
}

const BATCH_SIZE = 1000;

export async function seedDatabase(db) {
  console.log('[seed] Checking if seeding is needed...');

  const countResult = await db.query('SELECT COUNT(*) as cnt FROM logs');
  const existingCount = parseInt(countResult.rows[0].cnt, 10);

  if (existingCount >= 100000) {
    console.log(`[seed] Database already has ${existingCount} rows, skipping seed.`);
    return;
  }

  if (existingCount > 0) {
    console.log(`[seed] Partial seed detected (${existingCount} rows), clearing and reseeding...`);
    await db.query('TRUNCATE TABLE logs RESTART IDENTITY');
  }

  console.log('[seed] Generating 100,000 log entries...');
  const t0 = Date.now();
  const rows = generateRows(100000);
  console.log(`[seed] Generated in ${Date.now() - t0}ms`);

  console.log('[seed] Inserting rows in batches...');
  const t1 = Date.now();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);

    // Build a multi-row INSERT
    const values = [];
    const params = [];
    let paramIdx = 1;

    for (const row of batch) {
      values.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++})`);
      params.push(row.ts, row.severity, row.service, row.message);
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(', ')}`;
    await db.query(sql, params);

    if ((i / BATCH_SIZE) % 10 === 0) {
      console.log(`[seed] Inserted ${Math.min(i + BATCH_SIZE, rows.length)} / ${rows.length} rows...`);
    }
  }

  console.log(`[seed] Seeding complete in ${Date.now() - t1}ms`);
}
