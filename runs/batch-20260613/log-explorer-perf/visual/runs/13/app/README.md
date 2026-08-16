# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and serves windowed, filterable query
endpoints, paired with a Vanilla JS / Vite frontend that renders a virtualized
log table which stays fast at any scroll depth.

## Layout

```
/            root package.json with combined dev script
/server      Express + PGLite backend
/client      Vite + Vanilla JS frontend
```

## Install

```bash
npm run install:all
```

## Run (dev)

Runs backend (port 3001) and frontend (port 5173) together:

```bash
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the backend.

## Backend

- **Storage**: embedded PGLite persisted to `server/pgdata/`.
- **Seed**: on first boot, exactly 100,000 rows are inserted in batches of 2000
  (deterministic PRNG, seed `0x1234abcd`) spanning 30 days across 8 services with
  severities distributed ~60/25/10/5 (info/debug/warn/error). Subsequent boots
  detect the populated table and skip seeding.
- **Indexes**:
  - `idx_logs_ts` on `(ts DESC, id DESC)` — ordering / unfiltered windows.
  - `idx_logs_sev_ts` on `(severity, ts DESC, id DESC)` — severity + ordering.
  - `idx_logs_msg_trgm` GIN trigram on `lower(message)` when `pg_trgm` is
    available (falls back gracefully to an ordered scan otherwise).

### Endpoints

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - `rows` ordered by `ts DESC, id DESC`; every column returned.
  - `limit` capped at 200; invalid `offset`/`limit`/`severity` → `400`.
  - `severity` matches exactly; `q` is a case-insensitive substring; they
    combine. Filtering and slicing happen entirely in the database.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## Frontend

- Virtual scroller: the scroll container's height reflects the filtered `total`;
  only the rows intersecting the viewport (plus a small overscan) exist in the
  DOM, recycled from a pool via `transform: translateY`.
- Windows of 200 rows are fetched on demand and cached, with far-away windows
  evicted to bound memory.
- Severity dropdown + debounced (250 ms) search. Filter changes bump a query
  token, cancel in-flight requests, and reset scroll; stale responses are
  discarded so out-of-order responses never overwrite newer results.
- Severity is color-coded; the header shows "N of <total>".

## Measured budgets (full 100k corpus)

- Unfiltered windowed queries (`limit=100`) at offsets 0 / 50,000 / 99,900:
  well under 150 ms p95.
- Filtered queries (severity-only, selective and non-selective substrings, at
  deep offsets): well under 300 ms p95.
- First boot incl. seed: < 60 s; subsequent boots: < 10 s.
- No response ever exceeds 200 rows.
