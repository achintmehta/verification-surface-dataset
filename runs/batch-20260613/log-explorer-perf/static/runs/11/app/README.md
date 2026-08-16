# Log Explorer

A client-server log explorer for a high-volume service. The server seeds a
deterministic 100,000-row corpus into an embedded PGLite database and exposes
windowed, filterable query endpoints. The client renders a virtualized log
table that stays responsive anywhere in the corpus.

## Layout

```
package.json        # root: dev orchestration (concurrently)
server/             # Node.js + Express + PGLite backend
  src/
    config.js         # corpus shape + API constraints
    seedData.js       # deterministic row generation (pure fn of index)
    db.js             # PGLite lifecycle: schema, indexes, one-time seed
    logsRepository.js # SQL-side filtering / counting / windowing
    validation.js     # request param validation (400 on bad input)
    index.js          # Express app + routes + error handler
client/             # Vanilla JS + Vite frontend
  index.html
  src/
    api.js            # fetch wrappers with AbortController support
    virtualScroller.js# virtualized table: page cache, row pool, stale guard
    main.js           # wiring + debounced search + stats badges
    styles.css
```

## Running

```bash
npm run install:all   # install root, server, and client deps
npm run dev           # run backend (:3001) and frontend (:5173) together
```

The Vite dev server proxies `/api` to the backend, so the frontend uses
same-origin relative URLs. Open http://localhost:5173.

To run the backend alone: `npm run start`.

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC, id DESC` (stable total order).
  - `limit` capped at 200; `offset` ≥ 0; `severity` ∈ {debug,info,warn,error};
    `q` is a case-insensitive message substring. Bad params → `400`.
  - `total` is the exact filtered count; `rows` is one window only.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## How the budgets are met

**Windowed queries fast at any depth (< 150 ms).**
The ordering index `idx_logs_ts_id (ts DESC, id DESC)` backs `ORDER BY ts DESC,
id DESC`, so windowing reads directly from the index. Count and window run in
parallel per request. No endpoint ever returns more than 200 rows.

**Filtered queries (< 300 ms).**
- Severity: composite index `idx_logs_sev_ts_id (severity, ts DESC, id DESC)`
  serves equality + ordering + slicing from one index.
- Substring: a `pg_trgm` GIN index on `lower(message)` accelerates
  `lower(message) LIKE lower('%q%')` for both selective and non-selective terms
  instead of a full scan on every keystroke. (If `pg_trgm` is unavailable in a
  given PGLite build, ILIKE still returns correct results.)

**Boot / seed budget.**
The corpus is generated deterministically and inserted in batched multi-row
`INSERT`s (2,000 rows/statement) on first boot only. `db.js` checks for any
existing row and skips seeding on subsequent boots. Data persists on disk
(`server/.pgdata`), so a restart neither reseeds nor loses data.

**DOM bounded regardless of scroll (~100 rows).**
`virtualScroller.js` sizes a spacer to `total * ROW_HEIGHT` and only
materializes rows intersecting the viewport plus a small overscan, recycling
row elements as you scroll. Scroll handling only computes the visible window;
data fetches are async and never block scrolling or typing.

**No stale overwrites.**
Each filter change bumps a generation counter and aborts in-flight requests;
page fetches check the generation on resolve. Out-of-order responses for an old
filter are discarded, so newer results are never clobbered. Search input is
debounced (200 ms) and never blocked on a query.

**Correctness at the extremes.**
Because ordering uses a strict total order (`ts DESC, id DESC`) and paging uses
`LIMIT/OFFSET` over that index, the row at API offset `K` is stable and equals
what the UI shows when scrolled to row `K` — at the top, middle, and deepest
offset.
```
