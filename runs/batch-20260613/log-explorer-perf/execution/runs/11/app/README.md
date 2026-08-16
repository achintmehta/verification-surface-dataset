# Log Explorer

A client-server web app for exploring a high-volume (100,000-row) log corpus.
The server seeds a deterministic corpus into embedded PGLite and exposes
windowed, filterable query endpoints; the client renders a virtualized log
table that stays fast at any scroll position.

## Layout

```
server/   Node.js + Express + @electric-sql/pglite backend
client/   Vanilla JS + Vite virtualized frontend
```

## Running

```bash
npm run install:all   # install server + client deps
npm run dev           # run backend (:3001) and Vite dev server (:5173) together
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3001.

You can also run pieces individually:

```bash
npm run dev:server    # backend only
npm run dev:client    # frontend only
```

## Backend design

- **PGLite persists to `server/data/pgdata`** on the local file system, so the
  corpus survives a full server restart with no reseed or data loss.
- **Deterministic seed** (`server/src/seed-data.js`): a mulberry32 PRNG keyed by
  row index produces exactly 100,000 rows spanning 30 days across 8 services,
  severities distributed ~60/25/10/5 (debug/info/warn/error). Messages come from
  templates with common (non-selective) and rare (selective, e.g. `quasar`)
  fragments. Timestamps are monotonic in index order, so the row at any offset
  is well-defined and repeatable.
- **First-boot-only seeding** in batches of 5,000 (`server/src/db.js`).
  Subsequent boots detect the populated table and skip seeding.
- **Indexes** (`server/src/db.js`):
  - `(ts DESC, id DESC)` backs the base window query + ordering.
  - `(severity, ts DESC, id DESC)` backs severity-equality + ordering + slice.
  - A `pg_trgm` GIN index on `lower(message)` accelerates substring search when
    available; otherwise it falls back to a functional index and PGLite's fast
    in-memory scan (still well within budget at 100k rows).

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts` descending (with `id` as a stable tiebreaker).
  - `limit` capped at 200; responses never contain more than `limit` rows.
  - `severity` filters exactly; `q` matches message substrings
    case-insensitively; the two combine with AND.
  - Invalid params (negative offset, limit > 200, unknown severity,
    non-integers) return `400`.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## Frontend design

- **Virtual scroller** (`client/src/virtual-table.js`): a spacer element sized to
  `total * rowHeight` gives a correct scrollbar; only the rows intersecting the
  viewport (plus a small overscan) exist in the DOM, and their nodes are pooled
  and recycled while scrolling. DOM row count stays ~1 viewport regardless of
  scroll position.
- **Window fetching**: rows are loaded server-side one 200-row window at a time
  and cached by absolute index; scrolling anywhere fetches only the windows it
  needs.
- **Debounced search + stale-response guard**: search fires 200ms after the last
  keystroke; every filter change bumps a monotonic token and aborts in-flight
  requests, so out-of-order or superseded responses never overwrite newer state.
  The input is never blocked on a query.
- Severity is color-coded; a "N of TOTAL" count reflects the active filter.

## Performance budgets (verified at full 100k volume)

- Windowed `GET /api/logs` with `limit=100` at offset 0 / 50,000 / 99,900: all
  p95 < 150 ms (measured ~70–100 ms).
- Filtered queries (severity-only, selective substring, non-selective substring,
  each at deep offsets): all p95 < 300 ms (measured ~40–120 ms).
- First boot including full seed: well under 60 s. Subsequent boots: under 10 s
  (no reseed).
- No endpoint response ever contains more than 200 rows.
