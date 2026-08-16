# Log Explorer

A high-performance log explorer for a 100,000-row corpus with virtualized scrolling.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with a virtual scroller

## Quick Start

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001
- Frontend UI: http://localhost:5173

## First Boot

On first start, the server seeds 100,000 deterministic log entries into the embedded PGLite database. This takes ~30–60 seconds. Subsequent boots skip seeding and start in under 10 seconds.

## API

### `GET /api/logs`

Query parameters:
- `offset` (default: 0) — row offset (non-negative integer)
- `limit` (default: 100, max: 200) — number of rows to return
- `severity` — filter by severity: `debug`, `info`, `warn`, `error`
- `q` — case-insensitive message substring filter

Response: `{ total: number, rows: Row[] }`

### `GET /api/stats`

Response: `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets

| Query | Budget |
|-------|--------|
| `GET /api/logs?limit=100` at any offset | < 150ms p95 |
| Filtered queries (severity, substring) at deep offsets | < 300ms p95 |
| First boot (including seed) | < 60s |
| Subsequent boots | < 10s |
| Max rows per response | 200 |

## Indexes

- `idx_logs_ts_id` — `(ts DESC, id DESC)` — covers default sort
- `idx_logs_severity_ts_id` — `(severity, ts DESC, id DESC)` — covers severity filter + sort
- `idx_logs_message_trgm` — GIN trigram index on `message` — covers ILIKE substring search
