# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:
- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with virtualized scrolling

## Quick Start

```bash
# Install dependencies
npm install

# Start both server and client in development mode
npm run dev
```

- Backend API: http://localhost:3001
- Frontend UI: http://localhost:5173

## Architecture

### Backend

- **PGLite** stores 100,000 deterministic log entries on first boot
- **Windowed queries**: `GET /api/logs?offset=&limit=&severity=&q=` returns `{ total, rows }`
- **Indexes**: `(ts DESC)`, `(severity, ts DESC)`, GIN trigram on `message` for fast ILIKE
- **Batch seeding**: 2,000 rows per INSERT, wrapped in a single transaction

### Frontend

- **Virtual scroller**: only ~30–50 DOM rows exist at any time regardless of corpus size
- **Window caching**: fetch windows aligned to 150-row boundaries; small scrolls reuse cache
- **Debounced search**: 300ms debounce, stale responses discarded via sequence numbers
- **Abort on new request**: in-flight fetches are cancelled when a newer request is issued

## API

### `GET /api/logs`

Query parameters:
- `offset` (default: 0) — row offset, non-negative integer
- `limit` (default: 100, max: 200) — rows to return
- `severity` — filter by severity: `debug`, `info`, `warn`, `error`
- `q` — case-insensitive substring match on message

Response: `{ total: number, rows: Row[] }`

### `GET /api/stats`

Response: `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets

| Query | Budget |
|-------|--------|
| `GET /api/logs?limit=100` at any offset | < 150ms p95 |
| Filtered queries (severity, substring) at deep offsets | < 300ms p95 |
| First boot (including 100k seed) | < 60s |
| Subsequent boots (no reseed) | < 10s |
| Max rows per response | 200 |
