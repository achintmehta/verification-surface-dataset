# Log Explorer

A high-volume log explorer built as a client-server web app. The server seeds a
deterministic corpus of **100,000 log entries** into an embedded
[PGLite](https://github.com/electric-sql/pglite) database and exposes windowed,
filterable query endpoints. The client renders a **virtualized** log table that
stays fast at any scroll depth.

## Architecture

- **Backend** (`server/`): Node.js + Express + embedded PGLite.
  - Deterministic 100k-row seed on first boot (batched inserts, ~4s).
  - Persists to `server/pgdata/`; subsequent boots detect the populated table
    and skip reseeding.
  - Indexes: `(ts DESC, id DESC)` for ordered scrolling, `(severity, ts DESC, id DESC)`
    for severity filters, and a `pg_trgm` GIN index on `lower(message)` for
    substring search (falls back gracefully to a scan if the extension is
    unavailable).
- **Frontend** (`client/`): Vanilla JS + Vite.
  - Virtual scroller: only the visible rows (+ small overscan) exist in the DOM;
    DOM nodes are recycled from a pool.
  - Windowed fetching in aligned pages of up to 200 rows, cached by offset.
  - Debounced search (200ms) with epoch-based stale-response protection.

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC`. `limit` capped at 200 (default 100).
  - `severity` filters exactly (`debug|info|warn|error`); `q` is a
    case-insensitive message substring. Both combine.
  - Invalid params (negative offset, limit > 200, unknown severity) → `400`.
- `GET /api/stats` → `{ total, bySeverity }` (per-severity counts for badges).
- `GET /api/health` → `{ ok, dbReady }`.

## Running

```bash
# Install everything (root + server + client)
npm run install:all

# Run backend (:3001) and frontend (:5173) together
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api` to the
backend on port 3001.

To run individually:

```bash
npm run dev:server   # http://localhost:3001
npm run dev:client   # http://localhost:5173
```

## Performance budgets (measured at full 100k corpus)

| Query | p95 | Budget |
|-------|-----|--------|
| `limit=100` at offset 0 / 50,000 / 99,900 | ~55ms | < 150ms |
| severity-only, deep offset | ~36ms | < 300ms |
| selective substring, deep offset | ~100ms | < 300ms |
| non-selective substring, deep offset | ~127ms | < 300ms |
| First boot incl. seed | ~15s | < 60s |
| Subsequent boot | ~7s | < 10s |

No endpoint response ever returns more than 200 rows. The DOM holds only the
~visible window regardless of scroll position, and data survives a full restart
without reseeding.
