/**
 * Deterministic seed: 100,000 log entries spanning 30 days across 8 services.
 * Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error.
 * Messages drawn from templates with variable fragments for selective/non-selective search.
 */

const TOTAL_ROWS = 100_000;
const BATCH_SIZE = 2_000;

const SERVICES = [
  'api-gateway',
  'auth-service',
  'billing-service',
  'data-pipeline',
  'notification-svc',
  'search-engine',
  'storage-service',
  'user-service',
];

const SEVERITIES = ['info', 'info', 'info', 'info', 'info', 'info', // 60%
                    'debug', 'debug', 'debug',                        // 25% (approx via weighting)
                    'warn',                                            // 10%
                    'error'];                                          // ~5% (1/11 ≈ 9%, close enough)

// More precise distribution using cumulative thresholds
function getSeverity(n) {
  const v = n % 20;
  if (v < 12) return 'info';   // 60%
  if (v < 17) return 'debug';  // 25%
  if (v < 19) return 'warn';   // 10%
  return 'error';               // 5%
}

// Message templates — mix of selective (rare tokens) and non-selective (common tokens)
const MESSAGE_TEMPLATES = [
  // info templates
  (i) => `Request processed successfully for user_${i % 5000} in ${10 + (i % 490)}ms`,
  (i) => `Cache hit for key session_${i % 1000} ratio=${((i % 100) / 100).toFixed(2)}`,
  (i) => `Health check passed on instance node-${i % 16} uptime=${i % 86400}s`,
  (i) => `Scheduled job completed: cleanup_task_${i % 50} removed ${i % 200} records`,
  (i) => `Connection pool size adjusted to ${10 + (i % 40)} for service ${SERVICES[i % 8]}`,
  (i) => `Pagination query executed offset=${i % 100000} limit=${50 + (i % 150)} rows_returned=${i % 200}`,
  (i) => `Config reloaded from environment; feature_flag_${i % 30}=${i % 2 === 0 ? 'enabled' : 'disabled'}`,
  (i) => `Outbound webhook delivered to endpoint_${i % 200} status=200 latency=${5 + (i % 95)}ms`,
  // debug templates
  (i) => `SQL query plan: seq_scan=false index=idx_logs_ts cost=${(i % 500) / 10} rows=${i % 1000}`,
  (i) => `Trace span opened for operation fetch_user_profile id=span_${i % 9999}`,
  (i) => `Memory snapshot heap_used=${50 + (i % 450)}MB heap_total=${512 + (i % 512)}MB`,
  (i) => `Retry attempt ${1 + (i % 4)} for downstream call to ${SERVICES[(i + 3) % 8]}`,
  (i) => `Lock acquired on resource mutex_${i % 100} by worker_${i % 32}`,
  (i) => `Deserialized payload bytes=${128 + (i % 8192)} schema_version=${1 + (i % 5)}`,
  // warn templates
  (i) => `Slow query detected: ${200 + (i % 800)}ms threshold=200ms table=logs`,
  (i) => `Rate limit approaching for client_${i % 500}: ${80 + (i % 20)}% of quota used`,
  (i) => `Deprecated API endpoint /v1/legacy called by agent_${i % 300}`,
  (i) => `Disk usage at ${70 + (i % 25)}% on volume /data — consider cleanup`,
  // error templates
  (i) => `Unhandled exception in ${SERVICES[i % 8]}: NullPointerException at line ${100 + (i % 900)}`,
  (i) => `Failed to connect to upstream database after ${3 + (i % 5)} retries`,
  (i) => `Circuit breaker OPEN for dependency ${SERVICES[(i + 5) % 8]} error_rate=${50 + (i % 50)}%`,
];

// Simple deterministic LCG-based pseudo-random for reproducibility
function lcg(seed) {
  // LCG parameters (Numerical Recipes)
  return ((seed * 1664525 + 1013904223) & 0xffffffff) >>> 0;
}

export async function seedLogs(db, startFrom = 0) {
  // Base timestamp: 30 days ago from a fixed epoch for determinism
  const BASE_TS = new Date('2024-01-01T00:00:00Z').getTime();
  const SPAN_MS = 30 * 24 * 60 * 60 * 1000; // 30 days in ms

  let rng = 42; // deterministic seed

  // Pre-advance rng to account for already-inserted rows
  for (let i = 0; i < startFrom; i++) {
    rng = lcg(rng);
    rng = lcg(rng);
  }

  for (let batchStart = startFrom; batchStart < TOTAL_ROWS; batchStart += BATCH_SIZE) {
    const batchEnd = Math.min(batchStart + BATCH_SIZE, TOTAL_ROWS);
    const rows = [];

    for (let i = batchStart; i < batchEnd; i++) {
      rng = lcg(rng);
      const tsOffset = (rng % SPAN_MS + SPAN_MS) % SPAN_MS; // always positive
      const ts = new Date(BASE_TS + tsOffset).toISOString();

      rng = lcg(rng);
      const templateIdx = (rng >>> 0) % MESSAGE_TEMPLATES.length;
      const message = MESSAGE_TEMPLATES[templateIdx](i);

      const severity = getSeverity(i);
      const service = SERVICES[i % SERVICES.length];

      rows.push({ id: i + 1, ts, severity, service, message });
    }

    // Build a single multi-row INSERT for the batch
    const valuePlaceholders = [];
    const params = [];
    let paramIdx = 1;

    for (const row of rows) {
      valuePlaceholders.push(`($${paramIdx}, $${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4})`);
      params.push(row.id, row.ts, row.severity, row.service, row.message);
      paramIdx += 5;
    }

    const sql = `INSERT INTO logs (id, ts, severity, service, message) VALUES ${valuePlaceholders.join(', ')} ON CONFLICT (id) DO NOTHING`;
    await db.query(sql, params);

    if ((batchStart / BATCH_SIZE) % 10 === 0) {
      console.log(`[seed] Inserted up to row ${batchEnd}/${TOTAL_ROWS}`);
    }
  }
}
