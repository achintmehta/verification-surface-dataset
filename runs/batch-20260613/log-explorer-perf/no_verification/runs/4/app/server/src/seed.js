/**
 * Deterministic seed of exactly 100,000 log entries.
 *
 * Determinism: all randomness is driven by a simple LCG seeded at a fixed value,
 * so the corpus is identical across restarts.
 *
 * Distribution:
 *   severity: ~60% debug, ~25% info, ~10% warn, ~5% error
 *   services: 8 services, roughly uniform
 *   timestamps: span 30 days ending at a fixed epoch
 *   messages: drawn from templates with variable fragments so substring
 *             search has both selective (rare) and non-selective (common) terms
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 1_000; // 5,000 params per batch — well within PG's 65,535 limit

// Fixed epoch: 2024-01-30T00:00:00Z in ms
const END_TS = 1706572800000;
const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

// Severity distribution weights: ~60% debug, ~25% info, ~10% warn, ~5% error
const SEVERITY_WEIGHTS = [
  { sev: 'debug', weight: 60 },
  { sev: 'info',  weight: 25 },
  { sev: 'warn',  weight: 10 },
  { sev: 'error', weight: 5  },
];
const SEVERITY_TOTAL = 100;

// Message templates — mix of selective (rare words) and non-selective (common words)
const MESSAGE_TEMPLATES = [
  // debug
  (v) => `Processing request ${v.reqId} for user ${v.userId} on endpoint ${v.endpoint}`,
  (v) => `Cache ${v.cacheOp} for key ${v.cacheKey} took ${v.duration}ms`,
  (v) => `Database query executed in ${v.duration}ms rows_returned=${v.rows}`,
  (v) => `Heartbeat check passed for node ${v.nodeId} latency=${v.duration}ms`,
  (v) => `Config reload triggered by signal ${v.signal} version=${v.version}`,
  (v) => `Span ${v.spanId} started for operation ${v.operation}`,
  (v) => `Span ${v.spanId} finished duration=${v.duration}ms`,
  (v) => `Queue depth for ${v.queue} is ${v.depth} messages`,
  (v) => `Token validation succeeded for user ${v.userId} scope=${v.scope}`,
  (v) => `Retry attempt ${v.attempt} for job ${v.jobId}`,
  // info
  (v) => `User ${v.userId} logged in from ${v.ip} using ${v.authMethod}`,
  (v) => `Payment ${v.paymentId} processed successfully amount=${v.amount} currency=${v.currency}`,
  (v) => `File ${v.filename} uploaded size=${v.size} bucket=${v.bucket}`,
  (v) => `Search query "${v.searchTerm}" returned ${v.rows} results in ${v.duration}ms`,
  (v) => `Notification sent to ${v.userId} via ${v.channel} template=${v.template}`,
  (v) => `Service ${v.service} started version=${v.version} pid=${v.pid}`,
  (v) => `Scheduled job ${v.jobId} completed in ${v.duration}ms`,
  (v) => `API rate limit applied to ${v.ip} limit=${v.limit} window=${v.window}s`,
  // warn
  (v) => `Slow query detected duration=${v.duration}ms threshold=500ms query_hash=${v.queryHash}`,
  (v) => `Memory usage high rss=${v.rss}MB heap=${v.heap}MB threshold=${v.threshold}MB`,
  (v) => `Deprecated endpoint ${v.endpoint} called by ${v.ip} migrate_by=${v.deadline}`,
  (v) => `Retry limit approaching for job ${v.jobId} attempt=${v.attempt} max=${v.maxAttempts}`,
  (v) => `Certificate expiry warning domain=${v.domain} expires_in=${v.days}d`,
  (v) => `Connection pool exhausted pool=${v.pool} waiting=${v.waiting}`,
  // error
  (v) => `Unhandled exception in ${v.service} error="${v.errorMsg}" stack_hash=${v.stackHash}`,
  (v) => `Payment ${v.paymentId} failed reason="${v.errorMsg}" code=${v.errorCode}`,
  (v) => `Database connection lost host=${v.host} error="${v.errorMsg}"`,
  (v) => `Authentication failed for user ${v.userId} reason="${v.errorMsg}" ip=${v.ip}`,
  (v) => `File upload failed filename=${v.filename} error="${v.errorMsg}"`,
];

// Variable fragment pools
const USER_IDS    = Array.from({length: 500},  (_, i) => `u${String(i+1).padStart(5,'0')}`);
const REQ_IDS     = Array.from({length: 1000}, (_, i) => `req-${String(i+1).padStart(6,'0')}`);
const ENDPOINTS   = ['/api/users','/api/payments','/api/search','/api/files','/api/auth','/api/notifications','/api/analytics','/api/config'];
const CACHE_OPS   = ['hit','miss','evict','set'];
const CACHE_KEYS  = Array.from({length: 200}, (_, i) => `ck:${i}`);
const NODE_IDS    = Array.from({length: 20},  (_, i) => `node-${i+1}`);
const SIGNALS     = ['SIGHUP','SIGUSR1','SIGUSR2'];
const SPAN_IDS    = Array.from({length: 500}, (_, i) => `sp-${String(i).padStart(5,'0')}`);
const OPERATIONS  = ['read','write','delete','list','search','aggregate'];
const QUEUES      = ['email-queue','sms-queue','push-queue','audit-queue'];
const SCOPES      = ['read','write','admin','readonly'];
const IPS         = Array.from({length: 100}, (_, i) => `10.0.${Math.floor(i/256)}.${i%256}`);
const AUTH_METHODS= ['password','oauth2','saml','apikey'];
const PAYMENT_IDS = Array.from({length: 300}, (_, i) => `pay-${String(i+1).padStart(6,'0')}`);
const CURRENCIES  = ['USD','EUR','GBP','JPY','CAD'];
const FILENAMES   = Array.from({length: 200}, (_, i) => `file-${i+1}.dat`);
const BUCKETS     = ['uploads','backups','exports','imports'];
// Selective search terms (rare) and non-selective (common)
const SEARCH_TERMS= ['quantum','nebula','aurora','phoenix','cascade','delta','epsilon','zeta','omega','sigma',
                     'error','request','user','query','cache','file','payment','token','job','service'];
const CHANNELS    = ['email','sms','push','webhook'];
const TEMPLATES   = ['welcome','reset-password','invoice','alert','digest'];
const JOB_IDS     = Array.from({length: 100}, (_, i) => `job-${String(i+1).padStart(4,'0')}`);
const QUERY_HASHES= Array.from({length: 50},  (_, i) => `qh${String(i).padStart(4,'0')}`);
const DOMAINS     = ['api.example.com','auth.example.com','cdn.example.com'];
const POOLS       = ['pg-primary','pg-replica','redis-main'];
const HOSTS       = ['db-01','db-02','db-03'];
const ERROR_MSGS  = [
  'connection refused','timeout exceeded','permission denied','not found',
  'invalid token','quota exceeded','disk full','out of memory',
  'deadlock detected','constraint violation',
];
const ERROR_CODES = ['E001','E002','E003','E004','E005','E500','E503'];
const STACK_HASHES= Array.from({length: 30}, (_, i) => `sh${String(i).padStart(4,'0')}`);
const VERSIONS    = ['1.0.0','1.1.0','1.2.3','2.0.0','2.1.0'];

// Simple LCG for deterministic pseudo-random numbers
class LCG {
  constructor(seed) {
    this.state = seed >>> 0;
  }
  next() {
    // Parameters from Numerical Recipes
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state;
  }
  // Returns integer in [0, n)
  int(n) {
    return this.next() % n;
  }
  // Returns float in [0, 1)
  float() {
    return this.next() / 0x100000000;
  }
}

function pickSeverity(rng) {
  const r = rng.int(SEVERITY_TOTAL);
  let acc = 0;
  for (const { sev, weight } of SEVERITY_WEIGHTS) {
    acc += weight;
    if (r < acc) return sev;
  }
  return 'debug';
}

function makeVars(rng) {
  return {
    reqId:      REQ_IDS[rng.int(REQ_IDS.length)],
    userId:     USER_IDS[rng.int(USER_IDS.length)],
    endpoint:   ENDPOINTS[rng.int(ENDPOINTS.length)],
    cacheOp:    CACHE_OPS[rng.int(CACHE_OPS.length)],
    cacheKey:   CACHE_KEYS[rng.int(CACHE_KEYS.length)],
    duration:   rng.int(2000) + 1,
    rows:       rng.int(1000),
    nodeId:     NODE_IDS[rng.int(NODE_IDS.length)],
    signal:     SIGNALS[rng.int(SIGNALS.length)],
    version:    VERSIONS[rng.int(VERSIONS.length)],
    spanId:     SPAN_IDS[rng.int(SPAN_IDS.length)],
    operation:  OPERATIONS[rng.int(OPERATIONS.length)],
    queue:      QUEUES[rng.int(QUEUES.length)],
    depth:      rng.int(10000),
    scope:      SCOPES[rng.int(SCOPES.length)],
    attempt:    rng.int(5) + 1,
    jobId:      JOB_IDS[rng.int(JOB_IDS.length)],
    ip:         IPS[rng.int(IPS.length)],
    authMethod: AUTH_METHODS[rng.int(AUTH_METHODS.length)],
    paymentId:  PAYMENT_IDS[rng.int(PAYMENT_IDS.length)],
    amount:     (rng.int(100000) / 100).toFixed(2),
    currency:   CURRENCIES[rng.int(CURRENCIES.length)],
    filename:   FILENAMES[rng.int(FILENAMES.length)],
    size:       rng.int(100 * 1024 * 1024),
    bucket:     BUCKETS[rng.int(BUCKETS.length)],
    searchTerm: SEARCH_TERMS[rng.int(SEARCH_TERMS.length)],
    channel:    CHANNELS[rng.int(CHANNELS.length)],
    template:   TEMPLATES[rng.int(TEMPLATES.length)],
    service:    SERVICES[rng.int(SERVICES.length)],
    pid:        rng.int(65535) + 1,
    limit:      rng.int(1000) + 100,
    window:     rng.int(60) + 10,
    rss:        rng.int(2048) + 256,
    heap:       rng.int(1024) + 128,
    threshold:  rng.int(512) + 512,
    deadline:   `2024-${String(rng.int(9)+1).padStart(2,'0')}-01`,
    maxAttempts: rng.int(5) + 3,
    queryHash:  QUERY_HASHES[rng.int(QUERY_HASHES.length)],
    domain:     DOMAINS[rng.int(DOMAINS.length)],
    days:       rng.int(30) + 1,
    pool:       POOLS[rng.int(POOLS.length)],
    waiting:    rng.int(50),
    errorMsg:   ERROR_MSGS[rng.int(ERROR_MSGS.length)],
    errorCode:  ERROR_CODES[rng.int(ERROR_CODES.length)],
    host:       HOSTS[rng.int(HOSTS.length)],
    stackHash:  STACK_HASHES[rng.int(STACK_HASHES.length)],
  };
}

// Map severity to template index ranges
const TEMPLATE_RANGES = {
  debug: [0, 9],
  info:  [10, 17],
  warn:  [18, 23],
  error: [24, 28],
};

function generateRow(i, rng) {
  const severity = pickSeverity(rng);
  const service  = SERVICES[rng.int(SERVICES.length)];
  // Spread timestamps evenly across 30 days with small jitter
  const baseTs   = END_TS - SPAN_MS + Math.floor((i / TOTAL_ROWS) * SPAN_MS);
  const jitter   = rng.int(60000); // up to 1 minute jitter
  const ts       = new Date(baseTs + jitter).toISOString();

  const [tMin, tMax] = TEMPLATE_RANGES[severity];
  const templateIdx  = tMin + rng.int(tMax - tMin + 1);
  const vars         = makeVars(rng);
  const message      = MESSAGE_TEMPLATES[templateIdx](vars);

  return { id: i + 1, ts, severity, service, message };
}

export async function seedLogs(db) {
  const rng = new LCG(0xdeadbeef);

  // Wrap in a transaction for maximum throughput
  // PGLite supports standard PostgreSQL transaction control
  await db.query('BEGIN');

  try {
    for (let batchStart = 0; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
      const rows = [];

      for (let i = batchStart; i < batchEnd; i++) {
        rows.push(generateRow(i, rng));
      }

      // Build a multi-row INSERT with parameterized values
      // PGLite supports standard $1..$N params
      const placeholders = [];
      const values = [];
      let paramIdx = 1;

      for (const row of rows) {
        placeholders.push(`($${paramIdx}, $${paramIdx+1}, $${paramIdx+2}, $${paramIdx+3}, $${paramIdx+4})`);
        values.push(row.id, row.ts, row.severity, row.service, row.message);
        paramIdx += 5;
      }

      const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${placeholders.join(',')}`;
      await db.query(sql, values);

      if ((batchStart / BATCH_SIZE) % 10 === 0) {
        console.log(`[seed] Inserted ${batchEnd}/${TOTAL_ROWS} rows...`);
      }
    }

    await db.query('COMMIT');
  } catch (err) {
    try { await db.query('ROLLBACK'); } catch { /* ignore rollback errors */ }
    throw err;
  }
}
