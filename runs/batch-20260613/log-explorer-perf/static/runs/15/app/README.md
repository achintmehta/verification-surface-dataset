# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and exposes windowed, filterable query
endpoints, plus a Vanilla JS / Vite frontend with a virtualized log table.

## Layout

```
package.json        # workspace scripts (concurrently runs both dev servers)
server/             # Express + PGLite backend
  src/db.js         # PGLite init, schema, indexes
  src/seed.js       # deterministic 100k-row seed (batched, first-boot only)
  src/queries.js    # param validation + windowed/filtered queries
  src/index.js      # HTTP endpoints
  pgdata/           # persisted database (survives restarts, gitignored)
client/             # Vite + Vanilla JS frontend
  src/virtual-table.js  # DOM-recycling virtual scroller
  src/main.js           # filter wiring + debounced search
  src/api.js            # fetch helpers
```

## Install & Run

```bash
npm run install:all   # installs root, server and client deps
npm run dev           # runs backend (:3001) and frontend (:5173) together
```

The Vite dev server proxies `/api/*` to the backend on port 3001.

- First boot seeds 100,000 rows in batches and builds indexes (< 60s), then
  begins serving. Subsequent boots detect the populated table and skip seeding
  (< 10s).

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts` DESC, `id` DESC.
  - `limit` capped at 200; `offset` >= 0; `severity` one of debug/info/warn/error.
  - `q` matches `message` substrings case-insensitively.
  - Invalid params → `400`. Response never exceeds 200 rows.
- `GET /api/stats` → `{ total, bySeverity }`.

## Design notes / budgets

- **Server-side windowing:** the client never receives more than one 200-row
  window. Total count sizes the virtual scrollbar.
- **Indexes:** `(ts DESC, id DESC)` for ordering, `(severity, ts DESC, id DESC)`
  for severity + ordering, and a `pg_trgm` GIN index on `lower(message)` for
  substring search when the extension is available (graceful scan fallback).
- **Virtualization:** only the rows intersecting the viewport (plus a small
  overscan) exist in the DOM; row windows are fetched on demand and recycled.
- **Debounced search:** input is never blocked; a generation token ensures
  out-of-order / stale responses never overwrite newer results; in-flight
  requests for superseded filters are aborted.
