# Log Explorer

A high-volume log explorer: a Node.js + Express backend embedding
[PGLite](https://pglite.dev) with a deterministic 100,000-row corpus, exposing
windowed/filterable query endpoints, and a Vanilla JS / Vite frontend that
renders a **virtualized** log table which stays fast at any scroll depth.

## Architecture

```
app/
├── backend/          Express + PGLite (persisted to backend/pgdata/)
│   └── src/
│       ├── seed.js   Deterministic corpus generator (mulberry32 PRNG)
│       ├── db.js     PGLite init, schema, indexes, batched first-boot seed
│       └── server.js Express API: /api/logs, /api/stats
└── frontend/         Vite app
    └── src/
        ├── api.js    Abortable fetch client
        ├── main.js   Virtual scroller + filters + stale-response guarding
        └── style.css
```

## Running

```bash
npm run install:all      # install backend + frontend deps
npm run dev              # runs backend (:3001) and frontend (:5173) together
```

The frontend dev server proxies `/api/*` to the backend. Open
<http://localhost:5173>.

To run just the backend: `npm start`.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }` ordered by `ts DESC`. Rows contain
`id, ts, severity, service, message`.

- `offset` — non-negative integer (default `0`)
- `limit` — 1..200 (default `100`, capped at 200)
- `severity` — one of `debug|info|warn|error` (exact match; optional)
- `q` — case-insensitive substring of `message` (optional)

Invalid parameters (negative offset, limit > 200, unknown severity,
non-numeric) are rejected with **400**. No response ever contains more than
200 rows.

### `GET /api/stats`
Returns `{ total, bySeverity }` — total row count and per-severity counts for
the filter-bar badges.

## Design decisions

- **Server-side windowing with total count.** The client never receives more
  than one 200-row window. The database does the filtering, ordering, and
  slicing.
- **Indexes for the query shapes.** `logs (ts DESC, id DESC)` backs ordering;
  `logs (severity, ts DESC, id DESC)` backs severity-equality + ordering; an
  expression index on `lower(message)` supports the case-insensitive substring
  search. `id` is a stable tiebreaker so window boundaries never duplicate or
  skip rows.
- **First-boot-only batched seed.** 100k rows are generated deterministically
  and inserted in 1,000-row batches inside a single transaction, then
  `ANALYZE`d. Subsequent boots detect the populated table and skip reseeding.
  The corpus persists to `backend/pgdata/` and survives restarts.
- **Virtualized rendering with a recycled row pool.** Only the rows
  intersecting the viewport (plus a small overscan) exist in the DOM
  (~100 nodes max). Scroll position maps to a row offset; windows are fetched
  on demand and cached.
- **Debounced, cancellable search.** Typing debounces (200ms); each filter
  change bumps a generation token and aborts stale in-flight requests, so
  out-of-order responses never overwrite newer results.

## Performance budgets (met on the dev machine)

| Scenario | Budget | Measured p95 |
| --- | --- | --- |
| `limit=100` at offset 0 / 50k / 99.9k | < 150 ms | ~50 / 65 / 74 ms |
| severity-only deep | < 300 ms | ~37 ms |
| selective substring deep | < 300 ms | ~161 ms |
| non-selective substring deep | < 300 ms | ~129 ms |
| severity + substring deep | < 300 ms | ~52 ms |
| First boot incl. seed | < 60 s | ~19 s |
| Restart (no reseed) | < 10 s | ~9 s |
