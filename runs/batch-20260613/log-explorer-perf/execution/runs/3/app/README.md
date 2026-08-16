# Log Explorer

A high-performance log explorer for a 100,000-row corpus. Built with Node.js + Express + PGLite (embedded PostgreSQL) on the backend, and Vanilla JS + Vite with a virtualized scroll table on the frontend.

## Architecture

### Backend
- **Express** server on port 3001
- **PGLite** (embedded PostgreSQL) with persistent storage in `data/pglite/`
- **pg_trgm** extension for fast ILIKE substring search
- Deterministic seed of 100,000 log entries on first boot
- Windowed query API: `GET /api/logs?offset=&limit=&severity=&q=`

### Frontend
- **Vite** dev server on port 5173 (proxies `/api` to backend)
- **Virtualized scroll table**: only ~80 DOM rows regardless of corpus size
- Severity filter + debounced search box
- Severity color-coding and row count display

## Quick Start

```bash
# Install all dependencies
npm run install:all

# Start both servers (backend + frontend)
npm run dev
```

Or start them separately:
```bash
npm run dev:backend   # http://localhost:3001
npm run dev:frontend  # http://localhost:5173
```

## API

### `GET /api/logs`
Returns a window of log rows.

**Query params:**
- `offset` (integer ≥ 0, default 0)
- `limit` (integer 1–200, default 100)
- `severity` (debug|info|warn|error, optional)
- `q` (substring search, case-insensitive, optional)

**Response:**
```json
{
  "total": 100000,
  "rows": [
    {
      "id": 1,
      "ts": "2023-11-14T22:13:20.000Z",
      "severity": "debug",
      "service": "auth-service",
      "message": "Processing request 0 with correlation-id corr-0"
    }
  ]
}
```

### `GET /api/stats`
Returns per-severity counts.

**Response:**
```json
{
  "total": 100000,
  "bySeverity": {
    "debug": 60000,
    "info": 25000,
    "warn": 10000,
    "error": 5000
  }
}
```

## Performance Budgets (measured at full 100k corpus)

| Query type | p95 latency | Budget |
|---|---|---|
| Windowed (no filter), any offset | ~50ms | 150ms |
| Severity filter, deep offset | ~50ms | 300ms |
| Substring search (selective) | ~42ms | 300ms |
| Substring search (non-selective) | ~47ms | 300ms |
| Combined filter + deep offset | ~58ms | 300ms |

## Index Strategy

1. `idx_logs_ts_covering` — covering index on `(ts DESC) INCLUDE (id, severity, service, message)` for index-only scans on no-filter queries
2. `idx_logs_severity_ts` — index on `(severity, ts DESC)` for severity-filtered queries
3. `idx_logs_message_trgm` — GIN trigram index for fast ILIKE substring search

## Boot Times

- **First boot** (including 100k row seed + VACUUM ANALYZE): ~25s (budget: 60s)
- **Subsequent boots** (no reseeding): ~4–9s (budget: 10s)
