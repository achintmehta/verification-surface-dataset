# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:
- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with a virtualized log table

## Architecture

### Backend
- PGLite stores 100,000 deterministic log entries on first boot (subsequent boots skip seeding)
- Windowed query API: `GET /api/logs?offset=&limit=&severity=&q=`
- Indexes on `(ts DESC)`, `(severity, ts DESC)`, and `lower(message)` for fast queries
- Batch inserts (2,000 rows/batch) for fast seeding

### Frontend
- Virtual scroller: only ~30-50 DOM rows exist regardless of corpus size
- Debounced search (250ms) with AbortController-based request cancellation
- LRU window cache to avoid redundant fetches while scrolling

## Setup

```bash
# Install all dependencies (root + workspaces)
npm install

# Start both servers (backend :3001, frontend :5173)
npm run dev
```

Then open http://localhost:5173

## API

### `GET /api/logs`
Query parameters:
- `offset` — integer ≥ 0 (default: 0)
- `limit` — integer 1–200 (default: 100)
- `severity` — one of `debug`, `info`, `warn`, `error` (optional)
- `q` — case-insensitive message substring (optional)

Response: `{ total: number, rows: Array<{id, ts, severity, service, message}> }`

### `GET /api/stats`
Response: `{ total: number, bySeverity: { debug, info, warn, error } }`

### `GET /api/health`
Response: `{ status: "ok", uptime: number }`

## Performance Budgets

| Query | Budget |
|-------|--------|
| `GET /api/logs?limit=100` at offset 0, 50000, 99900 | < 150ms p95 |
| Severity-only filter + deep offset | < 300ms p95 |
| Selective substring + deep offset | < 300ms p95 |
| Non-selective substring + deep offset | < 300ms p95 |
| First boot (including seed) | < 60s |
| Subsequent boots | < 10s |
| Max rows per response | 200 |

## Data Corpus

- 100,000 rows spanning 30 days
- 8 services: auth-service, api-gateway, user-service, payment-service, notification-service, search-service, analytics-service, storage-service
- Severity distribution: ~60% debug, ~25% info, ~10% warn, ~5% error
- Messages drawn from 29 templates with variable fragments
- Selective search terms (e.g. "quantum", "nebula") and non-selective terms (e.g. "error", "request")
