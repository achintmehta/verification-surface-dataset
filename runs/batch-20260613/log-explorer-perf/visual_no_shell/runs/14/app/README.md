# Log Explorer

A client-server log explorer over a deterministic 100,000-row corpus seeded into an
embedded PGLite database, with a windowed/filterable query API and a virtualized
frontend that stays fast at full data volume.

## Layout

- `server/` — Node.js + Express + `@electric-sql/pglite`. Seeds 100k rows on first boot,
  exposes windowed query endpoints with server-side filtering and supporting indexes.
- `client/` — Vanilla JS + Vite. Virtualized log table with severity and debounced text filters.

## Running

```bash
npm run install:all   # installs root, server, and client deps
npm run dev            # runs server (:3001) and client (:5173) together
```

The Vite dev server proxies `/api/*` to the backend on port 3001.

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by `ts DESC`.
  `limit` is capped at 200. `severity` filters exactly; `q` is a case-insensitive
  message substring. Invalid params return `400`.
- `GET /api/stats` → `{ total, bySeverity }`.

## Design notes

- **Windowing**: the server never returns more than 200 rows. The client requests one
  window (200 rows) at a time based on scroll position and sizes its virtual scrollbar
  from `total`.
- **Indexes**: `(ts DESC, id DESC)` for base ordering, `(severity, ts DESC, id DESC)` for
  severity-filtered ordering, and a `pg_trgm` GIN index on `lower(message)` for substring
  search. Ordering is index-backed so deep offsets stay within budget.
- **Seeding**: batched multi-row inserts inside a single transaction; skipped entirely on
  subsequent boots when the table is already populated (data persists in `server/pgdata`).
- **Virtualization**: only the rows intersecting the viewport (+ small overscan) exist in
  the DOM; elements are pooled and recycled. DOM row count stays ~100 regardless of scroll.
- **Debounced search** with per-filter tokens and `AbortController` so stale responses can
  never overwrite newer results and the input is never blocked on queries.
