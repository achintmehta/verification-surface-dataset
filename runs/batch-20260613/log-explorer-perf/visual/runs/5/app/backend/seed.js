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
  // High frequency (non-selective)
  (r) => `Request processed successfully in ${r.int(10, 5000)}ms`,
  (r) => `Connection established to ${r.pick(['redis', 'postgres', 'kafka', 'elasticsearch'])}`,
  (r) => `Cache ${r.pick(['hit', 'miss', 'expired', 'invalidated'])} for key user:${r.int(1, 10000)}`,
  (r) => `Health check passed for endpoint ${r.pick(['/health', '/ready', '/live'])}`,
  (r) => `Metrics flushed: ${r.int(100, 10000)} data points`,
  (r) => `Worker thread ${r.int(1, 32)} completed task batch`,
  (r) => `Configuration reloaded from ${r.pick(['env', 'consul', 'vault', 'file'])}`,
  (r) => `Rate limit check: ${r.int(1, 1000)}/${r.int(1000, 5000)} requests`,
  // Medium frequency
  (r) => `User ${r.int(1000, 99999)} authenticated via ${r.pick(['oauth2', 'jwt', 'saml', 'basic'])}`,
  (r) => `Payment transaction ${r.hex(8)} ${r.pick(['initiated', 'completed', 'failed', 'refunded'])}`,
  (r) => `Inventory updated: SKU-${r.int(10000, 99999)} quantity changed by ${r.int(-100, 100)}`,
  (r) => `Email notification sent to user ${r.int(1000, 99999)} template:${r.pick(['welcome', 'reset', 'invoice', 'alert'])}`,
  (r) => `Search query "${r.pick(['laptop', 'phone', 'tablet', 'headphones', 'camera'])}" returned ${r.int(0, 500)} results`,
  (r) => `API request to ${r.pick(['/api/users', '/api/orders', '/api/products', '/api/payments'])} from IP ${r.ip()}`,
  (r) => `Database query executed in ${r.int(1, 2000)}ms rows_affected=${r.int(0, 10000)}`,
  (r) => `Session ${r.hex(16)} ${r.pick(['created', 'refreshed', 'expired', 'destroyed'])}`,
  // Selective (rare substrings)
  (r) => `CRITICAL: Circuit breaker OPEN for service ${r.pick(['payment-service', 'auth-service'])} after ${r.int(3, 10)} failures`,
  (r) => `Deadlock detected in transaction ${r.hex(8)}, retrying attempt ${r.int(1, 5)}`,
  (r) => `Memory pressure: heap usage at ${r.int(80, 99)}% of ${r.int(512, 4096)}MB limit`,
  (r) => `Slow query alert: ${r.int(2000, 30000)}ms for SELECT on table ${r.pick(['users', 'orders', 'events', 'logs'])}`,
  (r) => `TLS certificate for ${r.pick(['api.example.com', 'auth.example.com'])} expires in ${r.int(1, 30)} days`,
  (r) => `Kafka consumer lag: topic=${r.pick(['events', 'notifications', 'payments'])} partition=${r.int(0, 15)} lag=${r.int(0, 100000)}`,
  (r) => `Backup completed: ${r.int(100, 10000)}MB archived to s3://backups/${r.hex(8)}`,
  (r) => `Feature flag "${r.pick(['new-checkout', 'dark-mode', 'beta-search', 'ai-recommendations'])}" ${r.pick(['enabled', 'disabled'])} for ${r.int(0, 100)}% of users`,
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

function pickSeverity(rng) {
  const roll = rng.int(1, 100);
  for (let i = 0; i < SEVERITY_CUM.length; i++) {
    if (roll <= SEVERITY_CUM[i]) return SEVERITIES[i];
  }
  return 'info';
}

export function generateRows(count = 100000) {
  const rng = new LCG(42);
  const rows = [];

  // Span 30 days ending at a fixed point for determinism
  const endMs = new Date('2024-01-31T23:59:59Z').getTime();
  const startMs = endMs - 30 * 24 * 60 * 60 * 1000;
  const spanMs = endMs - startMs;

  for (let i = 0; i < count; i++) {
    // Deterministic timestamp spread across 30 days
    const tsMs = startMs + Math.floor(rng.float() * spanMs);
    const ts = new Date(tsMs).toISOString();

    const severity = pickSeverity(rng);
    const service = rng.pick(SERVICES);
    const template = MESSAGE_TEMPLATES[rng.next() % MESSAGE_TEMPLATES.length];
    const message = template(rng);

    rows.push({ ts, severity, service, message });
  }

  return rows;
}

export { SEVERITIES };
