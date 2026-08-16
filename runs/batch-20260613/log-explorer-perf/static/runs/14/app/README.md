# Log Explorer

A high-volume log explorer: an Express + embedded PGLite backend serving a
deterministic 100,000-row corpus through a windowed, filterable query API, and a
Vanilla JS + Vite frontend rendering a virtualized log table that stays fast at
any scroll depth.

## Layout

```
backend/   Express + @electric-sql/pglite (schema, seed, indexes, query API)
frontend/  Vite + Vanilla JS virtualized log table
```

## Install & run

```bash
npm run install:all   # install root, backend, frontend deps
npm run dev            # runs backend (:3001) and frontend (:5173) together
```

The frontend dev server proxies `/api/*` to the backend, so open
http://localhost:5173.

First backend boot seeds the corpus (target: within 60s). Data persists to
`backend/pgdata/`; subsequent boots detect the populated table and skip seeding
(target: within 10s). A full restart preserves the corpus with no reseed.

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - `offset`: non-negative integer (default 0)
  - `limit`: 1..200 (default 100), capped at 200
  - `severity`: one of `debug|info|warn|error` (exact match)
  - `q`: case-insensitive substring match on `message`
  - Ordered by `ts DESC, id DESC`. Invalid params → `400`.
- `GET /api/stats` → `{ total, bySeverity }`

## Design notes

- **Server-side windowing**: responses never exceed `limit` (max 200) rows; the
  client sizes its virtual scrollbar from `total`.
- **Indexes** (`db.js`): `(ts DESC, id DESC)` for ordering, `(severity, ts DESC,
  id DESC)` for severity-filtered queries, and a `pg_trgm` GIN index on
  `message` for substring search (with a graceful sequential fallback).
- **Virtualized rendering** (`virtual-table.js`): a spacer sized to
  `total * ROW_H` gives a real scrollbar; only rows in the viewport (+ overscan)
  are in the DOM, and row elements are pooled/recycled. Windows are fetched in
  200-row pages and cached with bounded size.
- **Stale-response safety**: both the per-filter total fetch and each window
  fetch carry an epoch/token; newer filter changes abort in-flight requests and
  cause older responses to be discarded.
