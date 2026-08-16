# Log Explorer

A client-server log explorer for a high-volume service. The backend seeds a
deterministic 100,000-row corpus into an embedded PGLite database and exposes
windowed, filterable query endpoints; the frontend renders a virtualized log
table that stays responsive across the entire corpus.

## Layout

```
package.json          # workspace scripts + dependencies
backend/
  server.js           # Express API: /api/logs, /api/stats
  db.js               # PGLite init, schema, deterministic seed, indexes
frontend/
  index.html
  vite.config.js
  src/main.js         # virtualized scroller + filters
  src/style.css
pgdata/               # PGLite data dir (gitignored, created on first boot)
```

## Running

```
npm install
npm run dev          # runs backend (:3001) and Vite frontend (:5173) together
```

Or individually:

```
npm run dev:backend  # node backend/server.js
npm run dev:frontend # vite frontend
```

The frontend proxies `/api` to the backend and also accepts an absolute
`VITE_API` origin.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }` ordered by `ts DESC` (id DESC tiebreak).
- `offset`: non-negative integer (default 0)
- `limit`: 1..200 (default 100, capped at 200)
- `severity`: one of `debug|info|warn|error` (exact match)
- `q`: case-insensitive message substring
- Invalid params → 400.

### `GET /api/stats`
Returns `{ total, bySeverity: { debug, info, warn, error } }`.

## Design notes

**Server-side windowing.** No response ever exceeds 200 rows. The client
receives one window at a time plus an exact `total` used to size the virtual
scrollbar.

**Indexes.**
- `idx_logs_ts (ts DESC, id DESC)` — ordering for the unfiltered and
  substring-filtered query shapes.
- `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity equality plus
  ordering.
- Substring search: this PGLite build lacks `pg_trgm`, so substring queries
  use the `message_lc` (pre-lowercased) column with `LIKE`, walking the
  ts-ordered index so `LIMIT/OFFSET` terminates early instead of sorting the
  whole match set. If `pg_trgm` is present, a GIN trigram index is created too.

**Deterministic seed.** A fixed-seed mulberry32 PRNG produces exactly 100,000
rows across 30 days, 8 services, severities ~60/25/10/5, from message
templates with both selective and non-selective fragments. Seeding is batched
(2,000 rows/insert) inside a transaction and runs only on first boot; later
boots detect the populated table and skip.

**Virtualized rendering.** The DOM holds only rows intersecting the viewport
plus a small overscan (~visible + 20). Windows are fetched and cached; a bounded
cache evicts windows farthest from the viewport. Filter changes bump a
monotonic token so stale in-flight responses are discarded, and the search box
is debounced (250 ms) and never blocked on queries.

## Performance budgets

- `/api/logs` `limit=100` under 150 ms (p95) at offsets 0 / 50,000 / 99,900.
- Filtered queries under 300 ms (p95) — severity-only, selective and
  non-selective substrings, combined with deep offsets.
- First boot including seed within 60 s; subsequent boots within 10 s.
- No response ever exceeds 200 rows.
- Corpus survives restart without reseeding.
