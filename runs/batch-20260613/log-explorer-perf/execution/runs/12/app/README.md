# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded PGLite backend that
seeds a deterministic 100,000-row corpus and serves windowed, filterable query
endpoints, plus a Vanilla JS / Vite frontend that renders a virtualized log
table which stays fast at full data volume.

## Setup

```bash
npm run install:all   # installs server + client deps
npm run dev           # runs backend (:3001) and frontend (:5173) together
```

First boot seeds 100k rows into `server/pgdata` (persisted to disk); subsequent
boots detect the populated table and skip seeding. Open http://localhost:5173.

## Backend

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`
  - Ordered by `ts DESC` (tie-break `id DESC`).
  - `limit` capped at 200 (400 if exceeded).
  - `severity` must be one of `debug|info|warn|error` (400 otherwise).
  - `q` matches message substrings case-insensitively; combines with severity.
  - Negative `offset`/`limit` → 400.
- `GET /api/stats` → `{ total, bySeverity }` for the filter badges.

### Schema & indexes

```sql
CREATE TABLE logs (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL,   -- debug/info/warn/error
  service TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX idx_logs_ts          ON logs (ts DESC, id DESC);
CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC, id DESC);
CREATE INDEX idx_logs_message_trgm ON logs USING gin (lower(message) gin_trgm_ops);
```

## Frontend virtualization

Only the rows intersecting the viewport (plus a small overscan) exist in the
DOM. A spacer sized to `total * rowHeight` drives the native scrollbar; scroll
position maps to a row offset, windows (200 rows) are fetched and cached, and
DOM nodes are recycled. Filters reset scroll and refetch; every request carries
a generation counter so stale/out-of-order responses never overwrite newer
results. Search is debounced and never blocks the input.
