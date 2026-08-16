# Log Explorer

A client-server web application for exploring a large, static log corpus. The
server seeds a deterministic 100,000-row corpus into an embedded
[PGLite](https://github.com/electric-sql/pglite) database and exposes windowed,
filterable query endpoints. The client renders a virtualized log table that
stays responsive at any scroll depth.

## Layout

```
package.json      # workspace scripts (dev runs both server + client)
server/           # Node + Express + PGLite backend
  src/db.js       # schema, deterministic seed, indexes
  src/queries.js  # param validation + windowed queries
  src/index.js    # Express app
client/           # Vite + Vanilla JS frontend
  src/virtualScroller.js  # windowed/recycled row rendering
```

## Install & Run

```bash
npm run install:all   # installs root, server, and client deps
npm run dev           # runs backend (:3001) and frontend (:5173) together
```

- Frontend: http://localhost:5173 (proxies `/api` to the backend)
- Backend:  http://localhost:3001

First boot seeds 100k rows (once). Subsequent boots detect the populated
database on disk (`server/data/pgdata`) and skip reseeding.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`

Returns `{ total, rows }`, rows ordered by `ts` descending.

- `offset` — non-negative integer (default `0`)
- `limit`  — 1..200 (default `100`, capped at 200)
- `severity` — one of `debug|info|warn|error` (optional, exact match)
- `q` — case-insensitive message substring (optional)

Invalid params → `400`. Response never contains more than 200 rows.

### `GET /api/stats`

Returns `{ total, bySeverity: { debug, info, warn, error } }`.

## Design notes

- **Server-side windowing**: the client never receives more than one page. The
  DB does filtering, ordering, and slicing.
- **Indexes**: `(ts DESC, id DESC)` for the default ordered scan, and
  `(severity, ts DESC, id DESC)` for severity-filtered ordering; a
  `lower(message)` expression index supports substring lookups. `ORDER BY ts DESC,
  id DESC` is stable so offsets are deterministic.
- **Deterministic seed**: rows are generated from a per-row PRNG seeded by id, so
  the corpus is fully reproducible; timestamps span 30 days across 8 services and
  severities are distributed ~info/debug/warn/error 60/25/10/5. Inserts are
  batched.
- **Virtualization**: total scroll height = `filteredTotal * rowHeight`; only the
  viewport slice (+ overscan) exists in the DOM using a recycled row pool. Data
  is fetched in 200-row pages; stale responses are discarded via a filter token +
  `AbortController`.
- **Debounced search** never blocks the input.
