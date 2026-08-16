// Deterministic seed data generation for 100,000 log entries
// Uses a simple seeded PRNG for full reproducibility

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
  'analytics-service',
];

// Severities with cumulative distribution: debug 60%, info 25%, warn 10%, error 5%
const SEVERITY_THRESHOLDS = [
  { severity: 'debug', threshold: 0.60 },
  { severity: 'info', threshold: 0.85 },
  { severity: 'warn', threshold: 0.95 },
  { severity: 'error', threshold: 1.0 },
];

// Message templates with variable fragments
// Some terms are selective (rare), some non-selective (common)
const MESSAGE_TEMPLATES = [
  // Non-selective (common words: "request", "processing", "completed")
  (rng) => `Processing request ${Math.floor(rng() * 100000)} completed successfully`,
  (rng) => `Request handled in ${Math.floor(rng() * 500)}ms`,
  (rng) => `Connection established from ${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}.${Math.floor(rng() * 256)}`,
  (rng) => `Cache hit for key user:${Math.floor(rng() * 10000)}`,
  (rng) => `Cache miss for key session:${Math.floor(rng() * 10000)}`,
  (rng) => `Database query executed in ${Math.floor(rng() * 200)}ms`,
  (rng) => `Health check passed, uptime ${Math.floor(rng() * 86400)}s`,
  (rng) => `Rate limit check passed for client ${Math.floor(rng() * 1000)}`,
  // Selective (rare words: "timeout", "circuit-breaker", "deadlock", "overflow")
  (rng) => `Connection timeout after ${Math.floor(rng() * 30000)}ms to upstream host`,
  (rng) => `Circuit-breaker tripped for downstream dependency port ${Math.floor(rng() * 65536)}`,
  (rng) => `Deadlock detected in transaction ${Math.floor(rng() * 99999)}`,
  (rng) => `Memory overflow warning: heap usage at ${Math.floor(70 + rng() * 30)}%`,
  (rng) => `Retrying failed operation attempt ${Math.floor(1 + rng() * 5)} of 5`,
  (rng) => `Authentication token validated for user ${Math.floor(rng() * 50000)}`,
  (rng) => `Payload size ${Math.floor(rng() * 10000)}KB exceeds soft limit`,
  (rng) => `Scheduled job batch-${Math.floor(rng() * 999)} started`,
  (rng) => `TLS handshake completed with cipher suite ECDHE-RSA-AES${Math.floor(rng() * 2) === 0 ? '128' : '256'}`,
  (rng) => `WebSocket connection opened for channel events:${Math.floor(rng() * 100)}`,
  (rng) => `DNS resolution for service-${Math.floor(rng() * 20)}.internal took ${Math.floor(rng() * 50)}ms`,
  (rng) => `Request processing middleware chain completed in ${Math.floor(rng() * 100)}ms`,
];

const TOTAL_ROWS = 100000;
// 30 days span; timestamps spread uniformly
const BASE_TS = new Date('2025-01-01T00:00:00Z').getTime();
const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

function generateRows() {
  const rng = mulberry32(42);
  const rows = [];

  for (let i = 0; i < TOTAL_ROWS; i++) {
    // Timestamp: spread uniformly across 30 days, then sorted later
    const ts = new Date(BASE_TS + Math.floor(rng() * SPAN_MS));

    // Severity
    const sevRoll = rng();
    let severity = 'debug';
    for (const st of SEVERITY_THRESHOLDS) {
      if (sevRoll < st.threshold) {
        severity = st.severity;
        break;
      }
    }

    // Service
    const service = SERVICES[Math.floor(rng() * SERVICES.length)];

    // Message
    const template = MESSAGE_TEMPLATES[Math.floor(rng() * MESSAGE_TEMPLATES.length)];
    const message = template(rng);

    rows.push({ ts, severity, service, message });
  }

  // Sort by timestamp ascending so IDs correspond to chronological order
  rows.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  return rows;
}

module.exports = { generateRows, TOTAL_ROWS };
