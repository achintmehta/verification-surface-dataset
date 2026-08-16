/**
 * Deterministic seed generator for 100,000 log entries.
 * Uses a simple LCG PRNG seeded at 42 for full reproducibility.
 */

const SEVERITIES = ['debug', 'info', 'warn', 'error'];
// Roughly 60/25/10/5 distribution
const SEVERITY_WEIGHTS = [60, 25, 10, 5];
const SEVERITY_CUM = [60, 85, 95, 100];

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

// Message templates with variable fragments for selective/non-selective substring search
const MESSAGE_TEMPLATES = [
  // High-frequency (non-selective) templates
  (r) => `Request processed successfully in ${r.int(10, 2000)}ms`,
  (r) => `Health check passed for endpoint ${r.pick(['/', '/health', '/ready', '/metrics'])}`,
  (r) => `Cache ${r.pick(['hit', 'miss', 'expired', 'invalidated'])} for key user:${r.int(1000, 9999)}`,
  (r) => `Database query executed in ${r.int(1, 500)}ms affecting ${r.int(0, 1000)} rows`,
  (r) => `Connection pool: ${r.int(1, 20)} active, ${r.int(0, 10)} idle, ${r.int(0, 5)} waiting`,
  (r) => `HTTP ${r.pick(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])} ${r.pick(['/api/users', '/api/orders', '/api/products', '/api/sessions'])} ${r.pick([200, 201, 204, 400, 401, 403, 404, 500])}`,
  (r) => `Session ${r.pick(['created', 'refreshed', 'expired', 'destroyed'])} for user ${r.int(10000, 99999)}`,
  (r) => `Retry attempt ${r.int(1, 3)} of 3 for operation ${r.pick(['send_email', 'process_payment', 'sync_inventory', 'update_cache'])}`,
  // Medium-frequency templates
  (r) => `Payment ${r.pick(['initiated', 'authorized', 'captured', 'refunded', 'failed'])} amount=${r.int(100, 100000)} currency=USD txn=${r.hex(8)}`,
  (r) => `User ${r.int(10000, 99999)} ${r.pick(['logged in', 'logged out', 'updated profile', 'changed password', 'reset 2FA'])}`,
  (r) => `Inventory updated: product_id=${r.int(1, 5000)} delta=${r.int(-100, 100)} warehouse=${r.pick(['US-EAST', 'US-WEST', 'EU-CENTRAL', 'APAC'])}`,
  (r) => `Search query "${r.pick(['laptop', 'phone', 'tablet', 'headphones', 'keyboard', 'monitor'])}" returned ${r.int(0, 500)} results in ${r.int(5, 300)}ms`,
  (r) => `Email ${r.pick(['queued', 'sent', 'bounced', 'opened', 'clicked'])} to ${r.int(10000, 99999)}@example.com template=${r.pick(['welcome', 'reset_password', 'order_confirm', 'invoice'])}`,
  (r) => `Rate limit ${r.pick(['checked', 'exceeded', 'reset'])} for client ${r.ip()} bucket=${r.pick(['global', 'per_user', 'per_endpoint'])}`,
  (r) => `Config reload: ${r.int(5, 50)} keys updated, ${r.int(0, 5)} deprecated, checksum=${r.hex(6)}`,
  // Low-frequency (selective) templates
  (r) => `CRITICAL: circuit breaker OPEN for downstream ${r.pick(['payment-gateway', 'fraud-detector', 'kyc-provider'])} after ${r.int(3, 10)} failures`,
  (r) => `Deadlock detected in transaction ${r.hex(12)}, rolling back`,
  (r) => `Memory pressure: heap ${r.int(70, 99)}% used, GC pause ${r.int(50, 500)}ms`,
  (r) => `Slow query alert: ${r.int(1000, 30000)}ms for SELECT on ${r.pick(['users', 'orders', 'products', 'sessions', 'audit_log'])}`,
  (r) => `Authentication failed for user ${r.int(10000, 99999)}: ${r.pick(['invalid_password', 'account_locked', 'token_expired', 'ip_blocked'])}`,
  (r) => `Webhook delivery failed to ${r.pick(['https://hooks.example.com', 'https://api.partner.io', 'https://notify.vendor.net'])}/callback after ${r.int(1, 5)} attempts`,
  (r) => `SSL certificate for ${r.pick(['api.example.com', 'auth.example.com', 'cdn.example.com'])} expires in ${r.int(1, 30)} days`,
  (r) => `Scheduled job ${r.pick(['cleanup_sessions', 'aggregate_metrics', 'sync_catalog', 'purge_logs', 'reindex_search'])} completed in ${r.int(100, 60000)}ms`,
];

// Simple LCG PRNG (Numerical Recipes parameters)
class LCG {
  constructor(seed) {
    this.state = BigInt(seed) & 0xFFFFFFFFFFFFFFFFn;
  }

  next() {
    this.state = (1664525n * this.state + 1013904223n) & 0xFFFFFFFFn;
    return Number(this.state);
  }

  // Float in [0, 1)
  float() {
    return this.next() / 0x100000000;
  }

  // Integer in [min, max]
  int(min, max) {
    return min + (this.next() % (max - min + 1));
  }

  pick(arr) {
    return arr[this.next() % arr.length];
  }

  hex(len) {
    let s = '';
    for (let i = 0; i < len; i++) {
      s += (this.next() % 16).toString(16);
    }
    return s;
  }

  ip() {
    return `${this.int(1, 254)}.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}

export function generateRows(count = 100000) {
  const rng = new LCG(42);

  // Time span: 30 days ending at a fixed epoch for determinism
  // Fixed end: 2024-01-30T00:00:00Z = 1706572800000 ms
  const END_MS = 1706572800000;
  const START_MS = END_MS - 30 * 24 * 60 * 60 * 1000;
  const SPAN_MS = END_MS - START_MS;

  const rows = [];

  for (let i = 0; i < count; i++) {
    // Deterministic timestamp spread across 30 days
    const tsMs = START_MS + Math.floor(rng.float() * SPAN_MS);
    const ts = new Date(tsMs).toISOString();

    // Severity with weighted distribution
    const roll = rng.int(1, 100);
    let severityIdx = 0;
    for (let s = 0; s < SEVERITY_CUM.length; s++) {
      if (roll <= SEVERITY_CUM[s]) { severityIdx = s; break; }
    }
    const severity = SEVERITIES[severityIdx];

    const service = SERVICES[rng.next() % SERVICES.length];

    // Pick a template
    const templateIdx = rng.next() % MESSAGE_TEMPLATES.length;
    const message = MESSAGE_TEMPLATES[templateIdx](rng);

    rows.push({ ts, severity, service, message });
  }

  return rows;
}
