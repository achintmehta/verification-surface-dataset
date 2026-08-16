# Log Explorer

A client–server log explorer over a deterministic 100,000-row corpus stored in
an embedded [PGLite](https://github.com/electric-sql/pglite) database. The
server exposes windowed, filterable query endpoints; the client renders a
virtualized log table that stays responsive at full corpus volume.

## Architecture

- **Backend** (`server/`): Node.js + Express + embedded PGLite.
  - `db.js` — PGLite init, deterministic seed (100k rows, 30-day span, 8
    services, severities ~60/25/10/5), indexes, and first-boot-only seeding.
  - `index.js` — Express API with CORS, JSON parsing, validation, and (when a
    build exists) static serving of the client.
- **Frontend** (`client/`): Vanilla JS + Vite virtualized table.
  - Only the rows intersecting the viewport (plus a small overscan) exist in the
    DOM; windows are fetched by offset, cached, and DOM rows are recycled.

## Data model

`logs(id BIGINT PK, ts TIMESTAMPTZ, severity TEXT, service TEXT, message TEXT)`

Indexes:
- `idx_logs_ts (ts DESC, id DESC)` — primary scroll ordering.
- `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity filter + ordering.
- `idx_logs_msg_trgm` — trigram GIN on `lower(message)` when `pg_trgm` is
  available; otherwise substring search falls back to an indexed-order scan
  (still well within budget at this volume).

## API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC`. `limit` capped at 200. `severity` filters exactly,
    `q` matches message substrings case-insensitively; both combine.
  - Invalid params (negative offset, limit > 200, unknown severity, non-integer)
    → `400`.
- `GET /api/stats` → `{ total, bySeverity }` for the filter badges.

## Running

```bash
npm install

# Dev: API (:3001) + Vite dev server (:5173, proxies /api)
npm run dev

# Production-style: build the client, then serve API + static UI from one port
npm run build
npm start           # http://localhost:3001
```

The first boot seeds the corpus (~15 s); subsequent boots detect the populated
table and skip reseeding (well under 10 s). Data persists in `pgdata/` and
survives restarts with no reseeding or loss.

## Performance (measured against the 100k corpus)

- Windowed queries `limit=100` at offset 0 / 50,000 / 99,900: p95 ~50 ms
  (budget < 150 ms).
- Filtered (severity-only, selective substring, non-selective substring, deep
  offsets): p95 ~40–110 ms (budget < 300 ms).
- No response ever exceeds 200 rows.
- DOM holds only the visible window (~40 rows) regardless of scroll position.
