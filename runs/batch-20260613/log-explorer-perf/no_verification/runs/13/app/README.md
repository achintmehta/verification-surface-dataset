# Log Explorer

A high-volume log explorer: an Express + embedded PGLite backend that seeds a
deterministic 100,000-row corpus and exposes windowed, filterable query
endpoints, plus a Vanilla JS / Vite frontend with a virtualized log table.

## Layout

```
.
├── package.json          # root scripts (run both dev servers together)
├── backend/              # Express + PGLite API
│   └── src/
│       ├── server.js     # HTTP server, routes, validation
│       └── db.js         # PGLite init, schema, deterministic seed, indexes
└── frontend/             # Vite + Vanilla JS virtualized UI
    ├── index.html
    └── src/
        ├── main.js       # virtual scroller, filters, debounced search
        └── style.css
```

## Install

```bash
npm run install:all
```

This installs the root dev dependency (`concurrently`) and the dependencies of
both the `backend` and `frontend` sub-projects.

## Run (development)

```bash
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173 (proxies `/api` to the backend)

On the **first** backend boot the 100,000-row corpus is seeded into a persistent
PGLite database under `backend/data/pgdata`. Subsequent boots detect the
populated table and skip seeding, so restarts are fast and lossless.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }` ordered by `ts` descending.

- `offset` — non-negative integer (default `0`).
- `limit`  — non-negative integer, **capped at 200** (default `100`).
- `severity` — exact match, one of `debug|info|warn|error`.
- `q` — case-insensitive message substring.

`severity` and `q` combine (AND). Invalid parameters (negative offset, limit
over the cap, unknown severity) return `400`. No response ever contains more
than 200 rows.

### `GET /api/stats`
Returns `{ total, bySeverity }` for the filter-bar badges.

### `GET /api/health`
Liveness probe.

## Design notes

- **Server-side windowing:** the client never receives more than one window
  (≤200 rows). The database performs filtering, ordering, and slicing.
- **Indexes:** `(ts DESC, id DESC)` for the default ordering, `(severity, ts
  DESC, id DESC)` for severity + ordering, and a `pg_trgm` GIN index on
  `lower(message)` for case-insensitive substring search (with a graceful
  sequential-scan fallback if the extension is unavailable).
- **Deterministic seed:** a fixed-seed PRNG and a fixed end instant make the
  corpus byte-identical on every fresh seed; timestamps span 30 days across 8
  services with severities distributed ~60/25/10/5.
- **Virtualized rendering:** the DOM holds only the rows intersecting the
  viewport plus a small overscan (~visible + 20 rows). Row nodes are recycled;
  the scroll spacer is sized to `total * rowHeight` so the scrollbar reflects
  the full filtered corpus.
- **Debounced search & stale-response guard:** typing debounces before firing a
  query; a monotonic request generation token discards any response that
  arrives after the filter has changed, so out-of-order responses never
  overwrite newer results.
