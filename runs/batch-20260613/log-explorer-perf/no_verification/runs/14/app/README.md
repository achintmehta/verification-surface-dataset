# Log Explorer

A high-volume log explorer: an embedded PGLite database seeded with 100,000
deterministic log entries, a windowed/filterable query API, and a virtualized
Vanilla JS + Vite frontend that stays responsive anywhere in the corpus.

## Layout

```
package.json      # root: runs both dev servers together (concurrently)
server/           # Node.js + Express + @electric-sql/pglite
  src/index.js    # Express app, /api/logs, /api/stats
  src/db.js       # PGLite init (persisted to server/pgdata), schema, indexes
  src/seed.js     # deterministic 100k-row batch seed
client/           # Vite + Vanilla JS virtualized UI
  index.html
  src/main.js     # virtual scroller, debounced search, stale-response guard
  src/style.css
```

## Install

```bash
npm run install:all   # installs root, server, and client deps
```

## Run (development)

```bash
npm run dev           # starts backend (:3001) and frontend (:5173) together
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the backend.

- **First boot** creates `server/pgdata`, seeds 100,000 rows in batches, then
  builds indexes (completes well within 60s).
- **Subsequent boots** detect the populated table and skip seeding (well within 10s).

## API

### `GET /api/logs?offset=&limit=&severity=&q=`
Returns `{ total, rows }` ordered by `ts DESC, id DESC`.
- `limit` capped at 200 (400 if exceeded).
- `offset` must be a non-negative integer (400 otherwise).
- `severity` must be one of `debug|info|warn|error` (400 for unknown values).
- `q` matches message substrings case-insensitively; combines with `severity`.
- No response ever contains more than 200 rows.

### `GET /api/stats`
Returns `{ total, bySeverity: { debug, info, warn, error } }`.

## Performance design

- Indexes: `(ts DESC, id DESC)` for ordering; `(severity, ts DESC, id DESC)` for
  severity-filtered windows; a `pg_trgm` GIN index on `lower(message)` for
  selective substring search (with graceful fallback if the extension is absent).
- The client never holds more than one window of rows in the DOM (~viewport +
  overscan). Scroll position maps directly to row offsets; windows are fetched on
  demand, cached, pruned, and DOM rows are recycled.
- Search is debounced and every request is tagged with a monotonic filter token,
  so stale/out-of-order responses are discarded.

## Persistence

PGLite writes to `server/pgdata/`, so the corpus survives full server restarts
with no reseeding or data loss.
