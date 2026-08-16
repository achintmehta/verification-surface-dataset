# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend serving
windowed, filterable queries over a deterministic 100,000-row corpus, and a
Vanilla JS / Vite frontend with a virtualized, recycling log table.

## Architecture

- **Backend (`server/`)** — Express API backed by embedded PGLite persisted to
  `server/pgdata/`. On first boot it seeds exactly 100,000 deterministic rows in
  batches and builds indexes; subsequent boots detect the populated table and skip.
- **Frontend (`client/`)** — Vite dev server. A virtual scroller renders only the
  rows intersecting the viewport (plus a small overscan), fetching data
  window-by-window (200 rows) and recycling row elements.

## Running

```bash
npm run install:all   # installs root, server, and client deps
npm run dev           # runs backend (:3001) and frontend (:5173) together
```

The client proxies `/api/*` to the backend (see `client/vite.config.js`).

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC, id DESC`. `limit` capped at 200 (default 100).
  - `severity` filters exactly (`debug|info|warn|error`); `q` is a
    case-insensitive substring match on `message`. Both combine.
  - Invalid params (negative offset, limit > 200, unknown severity) → 400.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## Schema & Indexes

`logs(id, ts, severity, service, message)` with:

- `idx_logs_ts_id (ts DESC, id DESC)` — index-backed ordering for the default view.
- `idx_logs_sev_ts_id (severity, ts DESC, id DESC)` — severity equality + ordering.
- `idx_logs_message_trgm` — GIN trigram index on `lower(message)` for substring search.

## Performance

Measured against the full 100k corpus (dev machine, p95 over repeated calls):

| Query                                   | p95     | Budget |
|-----------------------------------------|---------|--------|
| `limit=100` @ offset 0 / 50k / 99.9k    | ~55 ms  | 150 ms |
| severity-only @ deep offset             | ~40 ms  | 300 ms |
| selective substring @ deep offset       | ~57 ms  | 300 ms |
| non-selective substring @ deep offset   | ~69 ms  | 300 ms |
| First boot (incl. seed)                 | ~17 s   | 60 s   |
| Subsequent boot (no reseed)             | ~9 s    | 10 s   |

No endpoint response ever returns more than 200 rows. The DOM holds only the
visible window (~100 rows) regardless of scroll depth.
