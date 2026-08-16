# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend seeding
a deterministic 100,000-row corpus, exposing windowed/filterable query endpoints,
and a Vanilla-JS/Vite virtualized frontend that stays fast at any scroll depth.

## Running

```bash
npm install      # provisions dependencies
npm run dev      # starts backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173. Vite proxies `/api/*` to the backend.

- **First boot** seeds 100k rows into an on-disk PGLite database (`.pgdata/`),
  builds indexes, then starts serving (well under 60s; typically a few seconds).
- **Subsequent boots** detect the populated table and skip reseeding (< 10s).
  The corpus survives a full restart with no data loss.

## Architecture

### Backend (`server/`)

- `db.js` — PGLite initialization, schema, deterministic seed (mulberry32 PRNG),
  batched inserts (2,000 rows/batch), and indexes.
- `index.js` — Express app with the query API.

**Schema:** `logs(id, ts, severity, service, message)` with severities in
`debug|info|warn|error` distributed ~25/60/10/5, 8 services, timestamps spanning
30 days (monotonic with `id`, so ordering by `ts DESC` == `id DESC`). Messages
are drawn from per-severity templates with variable fragments, giving both
selective terms (e.g. `ERR_1042`) and non-selective terms (e.g. `request`).

**Indexes:**
- `idx_logs_ts (ts DESC, id DESC)` — ordering / unfiltered windowing.
- `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity filter + ordering.
- `idx_logs_msg_trgm` — GIN trigram index on `lower(message)` for `ILIKE`
  substring search *when `pg_trgm` is available*. If the extension is not
  present in the PGLite build, substring search falls back to a sequential scan,
  which for a 100k-row corpus of short messages still comfortably meets the
  300ms budget.

### API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC, id DESC`. `limit` capped at 200 (never returns more).
  - `severity` filters exactly; `q` is a case-insensitive substring on `message`;
    both combine. `total` is the exact filtered count.
  - Rejects with 400: negative/non-integer `offset`, `limit` < 1 or > 200,
    unknown `severity`.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

### Frontend (`client/`)

- Virtual scroller: a spacer element sized to `total * rowHeight` drives the
  native scrollbar; only the rows intersecting the viewport (+20 overscan) exist
  in the DOM and are recycled from a pool — the DOM never holds more than ~100
  log rows regardless of scroll position.
- Rows are fetched window-by-window (100 rows/request) and cached by absolute
  offset; scrolling to any position (top / middle / deepest offset) fetches and
  shows the correct rows with no permanently blank regions.
- Search is debounced (220ms); each filter change bumps a monotonic token and
  aborts in-flight requests, so out-of-order/stale responses never overwrite
  newer results and typing never blocks on queries.
- Severity is color-coded; the header shows the live "N matching rows" count for
  the active filter.

## Performance budgets (full 100k corpus)

- `GET /api/logs` with `limit=100` under 150ms at offset 0 / 50,000 / 99,900.
- Filtered queries (severity, selective substring, non-selective substring),
  combined with deep offsets, under 300ms.
- First boot incl. seed < 60s; subsequent boots < 10s.
- No response ever contains more than 200 rows.
