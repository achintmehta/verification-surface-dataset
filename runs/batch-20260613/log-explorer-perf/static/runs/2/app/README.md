# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:
- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/) with a virtualized log table

## Quick Start

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001
- Frontend UI: http://localhost:5173

On first boot, the server seeds 100,000 deterministic log entries (takes ~30–60s).
Subsequent boots skip seeding and start in under 10s.

## Architecture

### Backend

- `server/index.js` — Express app entry point
- `server/db.js` — PGLite initialization, schema creation, index creation
- `server/seed.js` — Deterministic 100k-row seed (LCG PRNG, batch inserts)
- `server/routes/logs.js` — `GET /api/logs` windowed query endpoint
- `server/routes/stats.js` — `GET /api/stats` per-severity counts

### Frontend

- `client/src/main.js` — App entry, filter wiring, render loop
- `client/src/virtualScroller.js` — DOM virtualization (only visible rows in DOM)
- `client/src/rowCache.js` — Windowed fetch with AbortController cancellation
- `client/src/api.js` — Typed API client

## API

### `GET /api/logs`

| Param      | Type    | Default | Description                          |
|------------|---------|---------|--------------------------------------|
| `offset`   | integer | 0       | Row offset (0-based)                 |
| `limit`    | integer | 100     | Rows to return (max 200)             |
| `severity` | string  | —       | Filter: `debug`, `info`, `warn`, `error` |
| `q`        | string  | —       | Case-insensitive message substring   |

Response: `{ total: number, rows: Row[] }`

### `GET /api/stats`

Response: `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets

| Query                                    | Budget |
|------------------------------------------|--------|
| `limit=100` at offset 0, 50k, 99.9k     | <150ms |
| Severity-only filter at deep offset      | <300ms |
| Selective substring at deep offset       | <300ms |
| Non-selective substring at deep offset   | <300ms |
| First boot (including seed)              | <60s   |
| Subsequent boots                         | <10s   |
| Max rows per response                    | 200    |

## Schema

```sql
CREATE TABLE logs (
  id        BIGSERIAL PRIMARY KEY,
  ts        TIMESTAMPTZ NOT NULL,
  severity  TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
  service   TEXT NOT NULL,
  message   TEXT NOT NULL
);

CREATE INDEX idx_logs_ts           ON logs (ts DESC);
CREATE INDEX idx_logs_severity_ts  ON logs (severity, ts DESC);
CREATE INDEX idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
```
