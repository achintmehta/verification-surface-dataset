# Log Explorer

A client–server log explorer for a high-volume service. The backend seeds a
deterministic 100,000-row corpus into an embedded PGLite database and exposes
windowed, filterable query endpoints. The frontend renders a virtualized log
table that stays responsive at full corpus size.

## Layout

```
.
├── package.json          # root: runs backend + frontend together
├── backend/              # Express + @electric-sql/pglite
│   └── src/
│       ├── config.js     # ports, data dir, corpus params, budgets
│       ├── corpus.js     # deterministic 100k-row generator (seeded PRNG)
│       ├── db.js         # PGLite init, schema, indexes, one-time seed
│       ├── queries.js    # param validation + windowed/stats queries
│       └── server.js     # HTTP API
└── frontend/             # Vanilla JS + Vite
    └── src/
        ├── api.js          # cancelable fetch client
        ├── virtual-table.js# virtual scroller with page cache + recycling
        ├── main.js         # filters, debounced search, wiring
        └── style.css
```

## Running

```bash
npm run install:all   # installs root, backend, frontend deps
npm run dev           # runs backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

First boot seeds the corpus (target < 60s); subsequent boots detect the
populated table and skip reseeding (target < 10s). Data persists to
`backend/.pgdata`, so the corpus survives restarts.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }` ordered by `ts DESC, id DESC`.

- `offset` — non-negative integer (default 0)
- `limit` — 1..200 (default 100); **never returns more than 200 rows**
- `severity` — exact match on `debug|info|warn|error`
- `q` — case-insensitive substring of `message`

Invalid parameters (negative offset, limit over 200, unknown severity) → `400`.
Filters combine (severity AND substring).

### `GET /api/stats`
Returns `{ total, bySeverity: { debug, info, warn, error } }`.

## How the budgets are met

**Windowed queries fast at any depth.** Every query orders by `ts DESC, id DESC`
backed by `idx_logs_ts_id`; severity filters use `idx_logs_sev_ts_id`. The
window is produced with `LIMIT/OFFSET` over an index-ordered scan, so no full
sort or full-table materialization happens per request. The response carries a
single window plus a `COUNT(*)` for scrollbar sizing.

**Filtered queries within budget.** Substring search uses a `pg_trgm` GIN index
on `lower(message)` with `lower(message) LIKE '%term%'`, keeping selective and
non-selective terms fast and case-insensitive.

**Seed once, in batches.** `corpus.js` generates rows from a seeded PRNG
(`mulberry32`) so the corpus is identical on every boot with no wall-clock
input. `db.js` inserts them in multi-row batches and seeds only when the table
is empty; a partial seed (crash mid-load) is detected and restarted cleanly.

**Bounded response size.** `limit` is validated and capped at 200 server-side.

**Virtualized rendering.** `virtual-table.js` sizes a spacer to
`rowHeight * total`, computes the visible row range from scroll position, and
keeps only visible rows (plus a small overscan) in the DOM via a recycled node
pool — so the DOM holds ~100 rows regardless of scroll depth. Rows are fetched
page-by-page (200 rows/page) and cached with LRU eviction.

**Responsive search, no stale writes.** The search box is debounced (200ms) and
never blocks input. A monotonically increasing `generation` token tags every
filter change; responses from an older generation are discarded, and in-flight
requests are aborted on filter change, so newer results always win.
