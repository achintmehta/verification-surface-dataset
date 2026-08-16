# Log Explorer

A high-volume log explorer: Node.js + Express + embedded PGLite backend with a
deterministic 100,000-row seed and windowed/filterable query API, and a Vanilla
JS / Vite virtualized frontend.

## Run

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3001
- Frontend: http://localhost:5173 (proxies `/api` to the backend)

First boot seeds the corpus (~few seconds) and builds indexes; subsequent boots
detect the populated table and skip reseeding.

## Architecture

### Backend (`server/`)
- **`db.js`** — PGLite instance persisted to `data/pgdata`. `logs` table
  (`id`, `ts`, `severity`, `service`, `message`). Deterministic seed (mulberry32
  PRNG) of exactly 100,000 rows across 30 days, 8 services, severities ~60/25/10/5
  (info/debug/warn/error), messages from templates with selective & non-selective
  fragments. Batched inserts. Indexes:
  - `(ts DESC, id DESC)` — primary ordering
  - `(severity, ts DESC, id DESC)` — severity equality + ordering
  - GIN trigram (`pg_trgm`) on `lower(message)` — case-insensitive substring search
- **`index.js`** — Express server (CORS + JSON).
  - `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
    `ts` desc, `limit` capped at 200, invalid params → 400.
  - `GET /api/stats` → `{ total, bySeverity }`.

### Frontend (`client/`)
- Virtual scroller: scroll height = filtered `total * rowHeight`; only visible
  rows (+ overscan) exist in the DOM via a recycled row pool. Windows fetched
  page-by-page (200 rows) with an LRU cache.
- Filters: severity dropdown + debounced (250 ms) search; changing a filter bumps
  a generation counter so stale/out-of-order responses are dropped, resets scroll,
  and refreshes `total`.
- Severity color-coding and a live "N of <corpus>" counter.

## Performance

- Windowed queries stay fast at any depth (index-backed ordering).
- Severity/substring filters combine server-side and stay within budget via the
  composite and trigram indexes.
- The DOM holds only ~viewport-worth of rows regardless of scroll position.
