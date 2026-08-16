# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and exposes windowed, filterable query
endpoints, and a Vanilla JS / Vite frontend that renders a virtualized log table.

## Architecture

- **Backend** (`server/`): Express API over an embedded PGLite database persisted
  to `server/pgdata/`. On first boot it seeds exactly 100,000 deterministic log
  rows in batches, then builds indexes. Subsequent boots detect the populated
  table and skip seeding.
- **Frontend** (`client/`): Vite dev server with a virtualized scroller. Only the
  rows intersecting the viewport (+ overscan) exist in the DOM; scroll position
  maps to a row offset and windows are fetched page-by-page from the API.

## Running

```bash
npm install        # installs root, then server + client deps (postinstall)
npm run dev        # runs backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173.

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
  `ts DESC`. `limit` capped at 200. `severity` filters exactly; `q` matches the
  message substring case-insensitively; both combine. Invalid params → 400.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## Performance decisions

- Server-side windowing: the client never receives more than one window of rows.
- Indexes: `(ts DESC, id DESC)` for default ordering, `(severity, ts DESC, id DESC)`
  for severity-filtered windows, and a `gin (lower(message) gin_trgm_ops)` trigram
  index for substring search.
- Batched inserts (2,000 rows/statement) keep first-boot seeding well within budget.
- Virtualized rendering with a recycled row pool bounds DOM size to ~100 rows.
- Debounced search + query tokens: input is never blocked and stale responses
  never overwrite newer results.
