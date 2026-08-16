# Log Explorer

A high-performance log explorer for a 100,000-row corpus. Built with Node.js + Express + PGLite (embedded PostgreSQL) on the backend, and Vanilla JS + Vite on the frontend.

## Architecture

### Backend (`/backend`)
- **Express** server with CORS and JSON body parsing
- **PGLite** embedded PostgreSQL database (persisted to `backend/data/logs.db`)
- **100,000 deterministic log entries** seeded on first boot (skipped on subsequent boots)
- **Windowed query API** — never returns more than 200 rows per request
- **Indexes** on `(ts DESC)`, `(severity, ts DESC)` for fast filtered/sorted queries

### Frontend (`/frontend`)
- **Vanilla JS** with **Vite** dev server
- **Virtual scroller** — only visible rows (+ overscan) exist in the DOM
- **Debounced search** with stale-response prevention
- **Severity filter** with per-level counts

## Quick Start

```bash
# Install dependencies
npm run install:all

# Start backend (seeds DB on first run, ~17s; subsequent runs ~9s)
npm run dev:backend

# In another terminal, start frontend
npm run dev:frontend
```

Then open http://localhost:5173

## API

### `GET /api/logs`
Returns a window of log entries.

**Query params:**
- `offset` — integer ≥ 0 (default: 0)
- `limit` — integer 1–200 (default: 100)
- `severity` — one of `debug|info|warn|error` (optional)
- `q` — message substring, case-insensitive (optional)

**Response:** `{ total: number, rows: Array<{id, ts, severity, service, message}> }`

### `GET /api/stats`
Returns total row count and per-severity counts.

**Response:** `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets (measured)

| Query | p50 | p95 |
|-------|-----|-----|
| Unfiltered, offset=0 | ~49ms | ~63ms |
| Unfiltered, offset=50,000 | ~70ms | ~79ms |
| Unfiltered, offset=99,900 | ~85ms | ~104ms |
| Severity filter, offset=50,000 | ~65ms | ~79ms |
| Selective substring (DEADLOCK) | ~241ms | ~263ms |
| Non-selective substring (user) | ~116ms | ~123ms |
| Non-selective substring, offset=50,000 | ~235ms | ~246ms |

All within the specified budgets:
- ✅ Windowed queries < 150ms p95 at any depth
- ✅ Filtered queries < 300ms p95
- ✅ First boot < 60s (actual: ~17s)
- ✅ Subsequent boots < 10s (actual: ~9.4s)
- ✅ No response ever contains > 200 rows

## Data Corpus

- **100,000 rows** spanning 30 days (Jan 1–30, 2024)
- **8 services**: auth-service, api-gateway, user-service, payment-service, notification-service, inventory-service, search-service, analytics-service
- **Severity distribution**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **Deterministic**: seeded with LCG PRNG (seed=42), identical across restarts
