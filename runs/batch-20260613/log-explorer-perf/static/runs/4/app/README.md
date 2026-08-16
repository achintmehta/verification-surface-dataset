# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with Node.js + PGLite (embedded PostgreSQL) on the backend and Vanilla JS + Vite on the frontend.

## Architecture

- **Backend**: Express + PGLite (embedded PostgreSQL) — seeds 100k deterministic log rows on first boot, exposes windowed query endpoints
- **Frontend**: Vanilla JS + Vite — virtualized log table that only renders visible rows, debounced search, severity filter

## Quick Start

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001
- Frontend UI: http://localhost:5173

## API

### `GET /api/logs`

Returns a window of log rows.

**Query parameters:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `offset` | integer ≥ 0 | 0 | Row offset |
| `limit` | integer 1–200 | 100 | Rows to return |
| `severity` | `debug`\|`info`\|`warn`\|`error` | — | Filter by severity |
| `q` | string | — | Case-insensitive message substring |

**Response:**
```json
{
  "total": 100000,
  "rows": [
    {
      "id": 1,
      "ts": "2024-01-30T23:59:59.000Z",
      "severity": "info",
      "service": "api-gateway",
      "message": "Received request for endpoint /api/v2/resource/42 from 10.0.1.5"
    }
  ]
}
```

### `GET /api/stats`

Returns per-severity counts.

```json
{
  "total": 100000,
  "debug": 60000,
  "info": 25000,
  "warn": 10000,
  "error": 5000
}
```

## Performance Budgets

| Query | Budget |
|-------|--------|
| `GET /api/logs?limit=100` at offset 0, 50000, 99900 | < 150ms p95 |
| Filtered queries (severity, substring) at deep offsets | < 300ms p95 |
| First boot (including 100k-row seed) | < 60s |
| Subsequent boots (no reseeding) | < 10s |
| Max rows per response | 200 |

## Corpus

- **100,000 rows** spanning 30 days (2024-01-01 to 2024-01-30)
- **8 services**: api-gateway, auth-service, billing-service, cache-service, data-pipeline, notification-service, search-service, user-service
- **Severity distribution**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **Messages**: 20 templates with variable fragments — mix of selective (trace IDs, error codes) and non-selective (request, connection, response) terms

## Indexes

```sql
-- All queries: ORDER BY ts DESC
CREATE INDEX idx_logs_ts ON logs (ts DESC);

-- Severity filter + ORDER BY ts DESC
CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);

-- Substring search (if pg_trgm available)
CREATE EXTENSION pg_trgm;
CREATE INDEX idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
```

## Frontend Features

- **Virtualized scrolling**: only ~30–50 DOM rows regardless of corpus size
- **Debounced search**: 300ms debounce, stale responses discarded
- **Severity filter**: color-coded chips with per-severity counts
- **Row count**: shows "N of total" reflecting active filters
- **Page cache**: up to 20 pages cached client-side for smooth back-scrolling
