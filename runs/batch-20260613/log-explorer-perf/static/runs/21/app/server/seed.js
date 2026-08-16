/**
 * Deterministic seed of 100,000 log entries.
 *
 * - Spans 30 days
 * - 8 services
 * - Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
 * - Messages from templates with variable fragments for selective/non-selective search terms
 */

const TOTAL_ROWS = 100000;
const BATCH_SIZE = 2000;

const SERVICES = [
  'api-gateway',
  'user-service',
  'order-service',
  'payment-service',
  'notification-service',
  'inventory-service',
  'auth-service',
  'analytics-service',
];

// Severity with cumulative distribution: debug 60%, info 25%, warn 10%, error 5%
const SEVERITIES = ['debug', 'info', 'warn', 'error'];
const SEVERITY_THRESHOLDS = [60, 85, 95, 100]; // cumulative percentages

// Simple deterministic PRNG (mulberry32)
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6d2b79f5) | 0;
    let v = t;
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

// Message templates with placeholders for variable fragments
const MESSAGE_TEMPLATES = [
  'Processing request for endpoint /{endpoint} with method {method}',
  'Database query executed in {duration}ms for table {table}',
  'Cache {cache_action} for key {cache_key}',
  'User {user_id} performed {action} on resource {resource}',
  'Connection pool status: {pool_active} active, {pool_idle} idle',
  'Health check passed for component {component}',
  'Rate limit threshold reached for client {client_id}',
  'Retry attempt {attempt} for operation {operation}',
  'Configuration reloaded: {config_key} updated',
  'Outbound HTTP call to {external_service} returned {status_code}',
  'Memory usage at {mem_pct}% of allocated heap',
  'Scheduled task {task_name} completed in {duration}ms',
  'Authentication token validated for session {session_id}',
  'Payload size {payload_size}KB exceeds soft limit',
  'Circuit breaker {cb_state} for downstream {downstream}',
  'Message published to queue {queue_name} with priority {priority}',
  'TLS handshake completed with cipher {cipher}',
  'Request correlation ID {correlation_id} traced across {span_count} spans',
  'Graceful shutdown initiated, draining {drain_count} connections',
  'Feature flag {flag_name} evaluated to {flag_value} for cohort {cohort}',
];

const ENDPOINTS = ['users', 'orders', 'payments', 'products', 'analytics', 'health', 'auth/login', 'auth/logout', 'inventory', 'notifications'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
const TABLES = ['users', 'orders', 'payments', 'products', 'sessions', 'audit_log', 'inventory'];
const CACHE_ACTIONS = ['hit', 'miss', 'eviction', 'refresh'];
const ACTIONS = ['created', 'updated', 'deleted', 'viewed', 'exported'];
const COMPONENTS = ['database', 'redis', 'queue', 'storage', 'cdn'];
const OPERATIONS = ['send_email', 'process_payment', 'sync_inventory', 'generate_report', 'validate_token'];
const EXTERNAL_SERVICES = ['stripe-api', 'sendgrid', 'twilio', 's3', 'cloudflare', 'datadog'];
const TASK_NAMES = ['cleanup_sessions', 'aggregate_metrics', 'sync_catalog', 'rotate_logs', 'backup_db'];
const CB_STATES = ['open', 'closed', 'half-open'];
const DOWNSTREAMS = ['payment-provider', 'email-service', 'search-index', 'cdn-origin', 'auth-provider'];
const QUEUE_NAMES = ['order-events', 'user-notifications', 'analytics-pipeline', 'audit-trail'];
const CIPHERS = ['TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256', 'TLS_AES_128_GCM_SHA256'];
const FLAG_NAMES = ['dark_mode', 'new_checkout', 'beta_search', 'enhanced_logging', 'rate_limit_v2'];
const CONFIG_KEYS = ['max_connections', 'timeout_ms', 'retry_count', 'log_level', 'cache_ttl'];

function pickFrom(arr, rng) {
  return arr[Math.floor(rng() * arr.length)];
}

function generateMessage(rng, templateIndex) {
  const template = MESSAGE_TEMPLATES[templateIndex % MESSAGE_TEMPLATES.length];
  return template
    .replace('{endpoint}', pickFrom(ENDPOINTS, rng))
    .replace('{method}', pickFrom(METHODS, rng))
    .replace('{duration}', String(Math.floor(rng() * 500) + 1))
    .replace('{table}', pickFrom(TABLES, rng))
    .replace('{cache_action}', pickFrom(CACHE_ACTIONS, rng))
    .replace('{cache_key}', `key_${Math.floor(rng() * 10000)}`)
    .replace('{user_id}', `usr_${Math.floor(rng() * 5000)}`)
    .replace('{action}', pickFrom(ACTIONS, rng))
    .replace('{resource}', `res_${Math.floor(rng() * 1000)}`)
    .replace('{pool_active}', String(Math.floor(rng() * 50)))
    .replace('{pool_idle}', String(Math.floor(rng() * 20)))
    .replace('{component}', pickFrom(COMPONENTS, rng))
    .replace('{client_id}', `client_${Math.floor(rng() * 200)}`)
    .replace('{attempt}', String(Math.floor(rng() * 5) + 1))
    .replace('{operation}', pickFrom(OPERATIONS, rng))
    .replace('{config_key}', pickFrom(CONFIG_KEYS, rng))
    .replace('{external_service}', pickFrom(EXTERNAL_SERVICES, rng))
    .replace('{status_code}', String(pickFrom([200, 201, 204, 400, 404, 500, 502, 503], rng)))
    .replace('{mem_pct}', String(Math.floor(rng() * 60) + 30))
    .replace('{task_name}', pickFrom(TASK_NAMES, rng))
    .replace('{session_id}', `sess_${Math.floor(rng() * 50000)}`)
    .replace('{payload_size}', String(Math.floor(rng() * 1000) + 10))
    .replace('{cb_state}', pickFrom(CB_STATES, rng))
    .replace('{downstream}', pickFrom(DOWNSTREAMS, rng))
    .replace('{queue_name}', pickFrom(QUEUE_NAMES, rng))
    .replace('{priority}', String(Math.floor(rng() * 10) + 1))
    .replace('{cipher}', pickFrom(CIPHERS, rng))
    .replace('{correlation_id}', `corr_${Math.floor(rng() * 100000)}`)
    .replace('{span_count}', String(Math.floor(rng() * 12) + 2))
    .replace('{drain_count}', String(Math.floor(rng() * 100) + 1))
    .replace('{flag_name}', pickFrom(FLAG_NAMES, rng))
    .replace('{flag_value}', pickFrom(['true', 'false'], rng))
    .replace('{cohort}', pickFrom(['alpha', 'beta', 'stable', 'canary'], rng));
}

// Escape single quotes for SQL
function escapeSQL(str) {
  return str.replace(/'/g, "''");
}

async function seedDatabase(db) {
  console.log(`[seed] Seeding ${TOTAL_ROWS} log entries...`);
  const startTime = Date.now();
  const rng = mulberry32(42); // deterministic seed

  // Base timestamp: 30 days ago
  const now = new Date('2025-01-15T00:00:00Z');
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  const baseTs = now.getTime() - thirtyDaysMs;

  // Pre-generate all timestamps to ensure they are sorted
  // We'll generate timestamps spread across 30 days
  const tsStep = thirtyDaysMs / TOTAL_ROWS;

  let inserted = 0;
  while (inserted < TOTAL_ROWS) {
    const batchEnd = Math.min(inserted + BATCH_SIZE, TOTAL_ROWS);
    const values = [];

    for (let i = inserted; i < batchEnd; i++) {
      // Deterministic timestamp: evenly spaced with small jitter
      const jitter = Math.floor(rng() * tsStep * 0.8);
      const ts = new Date(baseTs + i * tsStep + jitter);
      const tsStr = ts.toISOString();

      // Severity based on distribution
      const sevRoll = Math.floor(rng() * 100);
      let severity;
      if (sevRoll < 60) severity = 'debug';
      else if (sevRoll < 85) severity = 'info';
      else if (sevRoll < 95) severity = 'warn';
      else severity = 'error';

      const service = SERVICES[Math.floor(rng() * SERVICES.length)];
      const templateIndex = Math.floor(rng() * MESSAGE_TEMPLATES.length);
      const message = generateMessage(rng, templateIndex);

      values.push(
        `('${tsStr}', '${severity}', '${escapeSQL(service)}', '${escapeSQL(message)}')`
      );
    }

    const sql = `INSERT INTO logs (ts, severity, service, message) VALUES ${values.join(',\n')};`;
    await db.exec(sql);

    inserted = batchEnd;
    if (inserted % 10000 === 0 || inserted === TOTAL_ROWS) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[seed] Inserted ${inserted}/${TOTAL_ROWS} rows (${elapsed}s)`);
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`[seed] Seeding complete: ${TOTAL_ROWS} rows in ${totalElapsed}s`);
}

module.exports = { seedDatabase };
