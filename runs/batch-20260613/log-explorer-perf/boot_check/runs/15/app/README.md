# Log Explorer

A client-server log explorer: an Express + embedded PGLite backend seeding a
deterministic 100,000-row corpus and exposing windowed, filterable query
endpoints, plus a Vanilla JS / Vite virtualized log table.

## Install

```bash
npm run install:all
```

## Run (backend + frontend together)

```bash
npm run dev
```

- Backend API: http://localhost:3001
- Frontend (Vite dev server, proxies `/api` to the backend): http://localhost:5173

First backend boot seeds 100k rows (a few seconds); subsequent boots detect the
populated database and skip reseeding. The corpus is persisted under
`backend/data/pgdata` and survives restarts.

## Architecture

### Backend (`backend/`)

- **PGLite** persisted to `backend/data/pgdata`.
- `logs` table: `id`, `ts` (timestamptz), `severity` (debug/info/warn/error),
  `service`, `message`.
- Deterministic seed (mulberry32 PRNG): 100,000 rows over 30 days across 8
  services, severities ~60/25/10/5 (info/debug/warn/error), messages from
  templates with variable fragments. A rare `[QUARANTINE]` fragment on ~0.2%
  of rows provides a selective search term; common words like `orders` or
  `Request` are non-selective.
- Indexes:
  - `(ts DESC, id DESC)` — primary ordering / deep-offset windowing.
  - `(severity, ts DESC, id DESC)` — severity filter + ordering.
  - `gin (lower(message) gin_trgm_ops)` when `pg_trgm` is available; otherwise
    substring search falls back to an indexed-scan-free `lower(message) LIKE`.

### API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
  `ts DESC`. `limit` capped at 200. Invalid params → `400`.
- `GET /api/stats` → `{ total, bySeverity }` for filter badges.

### Frontend (`frontend/`)

- Absolute-positioned virtual scroller: a spacer sized to `total * rowHeight`,
  only the visible window (+ overscan) rendered, DOM rows recycled from a pool.
- Filters: severity dropdown + debounced search. Filter changes bump a
  monotonic token so stale in-flight responses never overwrite newer results
  and scroll resets to top.
- Pages fetched on demand (200 rows each) and cached per filter.
