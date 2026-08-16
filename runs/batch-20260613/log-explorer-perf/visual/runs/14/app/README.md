# Log Explorer

A client-server log explorer over a deterministic 100,000-row corpus stored in
embedded PGLite. The server exposes windowed, filterable query endpoints; the
client renders a virtualized log table that stays fast at any scroll depth.

## Architecture

- **Backend** (`backend/`): Node.js + Express + `@electric-sql/pglite`
  persisted to `./pgdata`. Seeds exactly 100k rows on first boot (batched),
  skips reseeding when the table is already populated.
- **Frontend** (`frontend/`): Vanilla JS + Vite. Virtual scroller with a
  recycled row-element pool, debounced search, and stale-response guarding.

## Query shapes & indexes

- `idx_logs_ts (ts DESC, id DESC)` — default ordering + deep offsets.
- `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity equality + order.
- `idx_logs_msg_trgm` — GIN trigram index for case-insensitive `ILIKE`
  substring search (falls back to a `lower(message)` index if `pg_trgm` is
  unavailable).

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
  `ts DESC`. `limit` capped at 200; invalid params → `400`.
- `GET /api/stats` → `{ total, bySeverity }`.

## Run

```bash
npm install
npm run dev        # backend (:3001) + frontend (:5173) together
```

Individually:

```bash
npm run dev:backend
npm run dev:frontend
```

## Performance budgets

- Windowed `limit=100` queries < 150 ms p95 at offset 0 / 50k / 99.9k.
- Filtered queries < 300 ms p95 (severity, selective & non-selective substrings).
- First boot incl. seed < 60 s; subsequent boots < 10 s.
- No response ever returns more than 200 rows.
