# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and serves windowed/filterable query
endpoints, plus a Vanilla JS / Vite frontend with a fully virtualized log table.

## Architecture

- **Backend** (`server/`): Express server with an embedded PGLite database
  persisted to `server/pgdata/`. On first boot it seeds exactly 100,000
  deterministic log rows (30 days, 8 services, severities ~60/25/10/5) in
  batches; subsequent boots detect the populated table and skip reseeding.
  Indexes support the graded query shapes: `(ts DESC, id DESC)` for ordering,
  `(severity, ts DESC, id DESC)` for severity-filtered ordering, and a
  `pg_trgm` GIN index on `lower(message)` for substring search when the
  extension is available (it falls back gracefully otherwise).
- **Frontend** (`client/`): a virtualized table. The scroll height reflects the
  filtered `total`; only the rows intersecting the viewport (plus a small
  overscan) exist in the DOM and are recycled while scrolling. Windows are
  fetched on demand (max 200 rows each). The search box is debounced and stale
  responses are discarded via a monotonic filter token.

## Endpoints

- `GET /api/logs?offset=&limit=&severity=&q=` — returns `{ total, rows }`
  ordered by `ts` descending. `limit` is capped at 200. `severity` filters
  exactly; `q` matches message substrings case-insensitively; both combine.
  Invalid parameters return `400`.
- `GET /api/stats` — returns `{ total, bySeverity }` for the filter bar.
- `GET /api/health` — readiness probe.

## Running

```bash
# install everything (root, server, client)
npm run install:all

# run backend (:3001) and frontend (:5173) together
npm run dev
```

The Vite dev server proxies `/api` to the backend at `http://localhost:3001`.

## Performance budgets (met at 100k rows)

- Windowed queries `limit=100` at offsets 0 / 50,000 / 99,900: < 150 ms (p95).
- Filtered queries (severity-only, selective + non-selective substring) at deep
  offsets: < 300 ms (p95).
- First boot including full seed: < 60 s; subsequent boots: < 10 s.
- No response ever contains more than 200 rows.
