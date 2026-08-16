# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and serves windowed, filterable
queries, plus a Vanilla JS / Vite frontend that renders a virtualized log table
which stays responsive anywhere in the corpus.

## Running

```bash
npm install
npm run dev
```

- Backend: http://localhost:3001 (seeds on first boot, persists to `.pgdata/`).
- Frontend (Vite dev server, proxies `/api` to the backend): http://localhost:5173

Run just one side:

```bash
npm run dev:server   # backend only
npm run dev:client   # frontend only (expects backend on :3001)
```

Production-style: `npm run build` then `npm start` serves the built client
from the same Express server.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }`, rows ordered by `ts DESC`.

- `offset` — non-negative integer (default 0).
- `limit` — 1..200 (default 100). **Never returns more than 200 rows.**
- `severity` — one of `debug|info|warn|error` (or `all`/omitted). Exact match.
- `q` — case-insensitive message substring. Combines with `severity`.
- Invalid params (negative offset, limit > 200, unknown severity) → `400`.

`total` is the exact count of the *filtered* corpus, used by the client to size
its virtual scrollbar.

### `GET /api/stats`
Returns `{ total, bySeverity }` for the filter-bar badges.

## Design

### Backend
- **Deterministic seed** (`server/db.js`): a fixed-seed mulberry32 PRNG
  produces exactly 100,000 rows spanning 30 days across 8 services, severities
  ~60/25/10/5 (info/debug/warn/error), messages from templates with variable
  fragments — including rare/selective terms (`deadlock`, `OOMKilled`) and
  common/non-selective ones (`request`, `completed`).
- **Seed on first boot only**: seeding is skipped when the table already has
  rows, and PGLite persists to `.pgdata/`, so a restart never reseeds or loses
  data. Inserts are batched (1,000-row multi-row `INSERT`s) and indexes are
  built *after* the bulk load, keeping first boot well under 60s.
- **Indexes for the query shapes**: `(ts DESC, id DESC)` for the base ordered
  window and `(severity, ts DESC, id DESC)` for severity-filtered ordered
  windows, so even deep offsets are index-backed. Substring search uses a
  sequential scan (no leading-wildcard b-tree index exists; pg_trgm is not
  bundled), which fits the 300ms budget at 100k short rows.
- **Windowing**: the server does `COUNT(*)` + `LIMIT/OFFSET` in the database;
  a response is at most one window (≤200 rows).

### Frontend (`client/src/main.js`)
- **Virtual scroller**: a spacer div sized to `total * rowHeight` drives the
  native scrollbar; only rows intersecting the viewport (plus small overscan)
  exist in the DOM, positioned via `translateY`. A recycled element pool bounds
  the DOM to ~visible+overscan rows regardless of scroll position.
- **Window fetching + cache**: rows are fetched in 200-row pages keyed by
  offset and cached; scrolling to any offset (top/middle/deepest) requests just
  that page.
- **Debounced search + stale-response guard**: search fires after a 200ms
  debounce without blocking input; every filter change bumps a monotonic epoch,
  and responses from a superseded epoch are discarded so out-of-order responses
  never overwrite newer results.
- **Filters reset scroll**, refresh `total`, and re-render; severity is
  color-coded and a live "N of M" count reflects the active filter.
