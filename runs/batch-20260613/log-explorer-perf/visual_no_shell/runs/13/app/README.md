# Log Explorer

A high-volume log explorer: a Node.js/Express server backed by an embedded
PGLite database seeded with 100,000 deterministic log entries, and a Vanilla
JS / Vite frontend that renders a virtualized, filterable log table.

## Run

```bash
npm install      # provisioned by the environment
npm run dev      # starts backend (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173.

- First boot seeds 100k rows into `./pgdata` (a local PGLite directory) — under 60s.
- Subsequent boots detect the populated table and skip seeding — under 10s.

## Architecture

### Backend (`server/`)
- `db.js` — PGLite init, schema, deterministic 100k-row seed (batched inserts),
  and indexes:
  - `idx_logs_ts (ts DESC, id DESC)` — the primary ordering shape.
  - `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity-equality + ordering.
  - `idx_logs_msg_trgm` — trigram GIN index on `lower(message)` for
    case-insensitive substring search (falls back to plain `ILIKE` if the
    `pg_trgm` extension is unavailable in the PGLite build; in-memory scan is
    still well within budget at this corpus size).
- `index.js` — Express API:
  - `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
    `ts DESC`. `limit` capped at 200. Invalid params → 400. Filtered totals are
    cached so deep-offset scrolling within a filter avoids re-counting.
  - `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

### Frontend (`client/`)
- Virtual scroller: a spacer div sized to `total * rowHeight` drives a native
  scrollbar; only the rows intersecting the viewport (plus overscan) exist in
  the DOM and are recycled on scroll.
- Rows are fetched window-by-window (200 rows/window) and cached by offset.
- Severity dropdown + debounced (200ms) search box. Every filter change bumps a
  monotonic token; stale/out-of-order responses are discarded so newer results
  are never overwritten.

## Performance budgets (met at full 100k corpus)
- Windowed `GET /api/logs` (limit=100) < 150ms at offset 0 / 50k / 99.9k.
- Filtered queries < 300ms including deep offsets.
- First boot (incl. seed) < 60s; reboot < 10s (no reseed).
- No response ever contains more than 200 rows.
- DOM holds ~one viewport of rows regardless of scroll position.
