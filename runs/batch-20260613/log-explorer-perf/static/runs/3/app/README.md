# Log Explorer

A high-performance log explorer for a 100,000-row corpus with virtualized scrolling and server-side windowed queries.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with a custom virtual scroller

## Setup

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001
- Frontend UI: http://localhost:5173

## First Boot

On first boot, the server seeds 100,000 deterministic log entries into the embedded PGLite database. This takes ~30–60 seconds. Subsequent boots skip seeding and start in seconds.

## API

### `GET /api/logs`

Returns a windowed slice of the log corpus.

**Query parameters:**
- `offset` (default: 0) — row offset (non-negative integer)
- `limit` (default: 100, max: 200) — number of rows to return
- `severity` (optional) — filter by severity: `debug`, `info`, `warn`, `error`
- `q` (optional) — case-insensitive message substring filter

**Response:**
```json
{
  "total": 100000,
  "rows": [
    { "id": 1, "ts": "2024-01-15T14:23:45.123Z", "severity": "info", "service": "api-gateway", "message": "..." }
  ]
}
```

### `GET /api/stats`

Returns total row count and per-severity counts.

**Response:**
```json
{
  "total": 100000,
  "bySeverity": { "debug": 60000, "info": 25000, "warn": 10000, "error": 5000 }
}
```

## Performance Budgets

- Windowed queries (`limit=100`) at any offset: < 150ms p95
- Filtered queries at deep offsets: < 300ms p95
- First boot (including seed): < 60 seconds
- Subsequent boots: < 10 seconds
- Max rows per response: 200

## Features

- **Virtualized scrolling**: Only ~50 DOM rows at any time regardless of corpus size
- **Server-side filtering**: Severity and substring filters applied in PostgreSQL
- **Debounced search**: 250ms debounce, stale responses discarded
- **Severity badges**: Click to filter by severity; shows per-severity counts
- **Deep offset support**: Scroll to any position in 100k rows instantly
