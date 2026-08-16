# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds 100,000 deterministic log rows and serves windowed/filterable queries, and
a Vanilla JS / Vite frontend that renders a virtualized, filterable log table.

## Architecture

### Backend (`server/`)
- **PGLite** embedded PostgreSQL persisted to `server/pgdata/` — survives restarts.
- **Schema**: `logs(id, ts, severity, service, message)` with a CHECK on severity.
- **Seed**: exactly 100,000 rows spanning 30 days across 8 services, severities
  roughly 60/25/10/5, messages from templates with selective and non-selective
  substring tokens. Deterministic (seeded PRNG) and inserted in batches inside a
  single transaction. Seeding runs only on first boot; a populated table is
  detected and skipped afterward.
- **Indexes**: `(ts DESC, id DESC)` for ordering, `(severity, ts DESC, id DESC)`
  for severity-filtered ordering, and a `pg_trgm` GIN index on `lower(message)`
  for substring search.

### API
- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
  `ts DESC`. `limit` capped at 200. Filters combine; invalid params return 400.
- `GET /api/stats` → `{ total, bySeverity }` for filter-bar badges.

### Frontend (`client/`)
- Virtual scroller: a spacer sized to `total * rowHeight` drives the scrollbar;
  only visible rows (+ overscan) exist in the DOM and are recycled from a node
  pool. Rows are fetched window-by-window (200 at a time) and cached by offset.
- Severity dropdown + debounced search. A monotonic filter token guarantees that
  out-of-order / stale responses never overwrite newer results. Changing a filter
  resets scroll, clears the cache, and re-establishes `total`.

## Running

Install everything (backend + frontend), then run both dev servers:

```bash
npm run install:all
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173 (proxies `/api` to the backend)

First boot seeds the corpus (well within the 60s budget); subsequent boots skip
seeding and start in a few seconds.
