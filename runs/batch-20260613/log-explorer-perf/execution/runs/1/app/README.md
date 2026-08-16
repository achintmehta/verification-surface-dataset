# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:
- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with virtualized scrolling

## Architecture

### Backend
- **PGLite** embedded database persisted to `backend/data/pglite/`
- **100,000 deterministic log entries** seeded on first boot (LCG PRNG, seed=42)
- **Windowed query API**: never returns more than 200 rows per request
- **Indexes**: `(ts DESC)` for ordering, `(severity, ts DESC)` for filtered queries
- **ANALYZE** run after seeding for optimal query planner statistics

### Frontend
- **Virtual scroller**: only ~30-50 DOM rows exist at any time regardless of corpus size
- **Debounced search**: 300ms debounce, AbortController cancels stale requests
- **Window-aligned fetching**: 150-row windows centered on the viewport
- **LRU cache**: up to 30 windows cached client-side

## Performance Budgets (met)

| Query type | Budget | Actual p95 |
|---|---|---|
| Windowed (offset 0, 50k, 99.9k) | 150ms | ~85ms |
| Severity filter + deep offset | 300ms | ~65ms |
| Substring search (selective) | 300ms | ~175ms |
| Substring search (non-selective) | 300ms | ~230ms |
| Combined filter + deep offset | 300ms | ~230ms |

## Getting Started

```bash
# Install all dependencies
npm run install:all

# Start both servers (requires concurrently)
npm run dev

# Or start individually:
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:5173
```

## API

### `GET /api/logs`
Returns a window of log entries.

**Query params:**
- `offset` (int ≥ 0, default 0)
- `limit` (int 1–200, default 100)
- `severity` (debug|info|warn|error, optional)
- `q` (message substring, case-insensitive, optional)

**Response:** `{ total: number, rows: [{id, ts, severity, service, message}] }`

### `GET /api/stats`
Returns per-severity counts.

**Response:** `{ total: number, bySeverity: {debug, info, warn, error} }`

## Data Corpus

- **100,000 rows** spanning 30 days (2024-01-01 to 2024-01-31)
- **8 services**: auth-service, api-gateway, user-service, payment-service, notification-service, inventory-service, search-service, analytics-service
- **Severity distribution**: debug ~60%, info ~25%, warn ~10%, error ~5%
- **Deterministic**: same rows every time (LCG PRNG seed=42)
- **Selective terms**: NullPointerException, OutOfMemoryError, gateway timeout (~1-5% of rows)
- **Non-selective terms**: user, order, service (~50%+ of rows)
