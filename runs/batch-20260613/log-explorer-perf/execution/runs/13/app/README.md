# Log Explorer

A high-volume log explorer: a Node.js + Express + embedded **PGLite** backend
seeded with a deterministic 100,000-row corpus, exposing windowed/filterable
query endpoints, and a Vanilla JS + Vite **virtualized** frontend that stays
fast anywhere in the corpus.

## Running

```bash
npm install
npm run dev        # runs backend (:3001) and Vite frontend (:5173) together
```

Or run separately:

```bash
npm run server     # Express + PGLite on :3001
npm run client     # Vite dev server on :5173 (proxies /api -> :3001)
```

Open http://localhost:5173.

- **First boot** seeds 100k rows into `.pgdata/` (a few seconds) and then serves.
- **Subsequent boots** detect the populated table and skip seeding.
- Data survives restarts (PGLite persists to `.pgdata/`).

## Backend

### Data (`server/db.js`)
- `logs(id, ts TIMESTAMPTZ, severity, service, message)`.
- 100,000 rows, deterministic (`mulberry32` PRNG, fixed seed), spanning 30 days
  across 8 services. Severity distribution ≈ 60/25/10/5 (info/debug/warn/error).
- Messages from templates with variable fragments; some rows carry rare tokens
  (e.g. `quasar`) so substring search has both **selective** and
  **non-selective** terms.
- Seeded in batches on first boot only.

### Indexes
- `idx_logs_ts (ts DESC, id DESC)` — default ordering / deep-offset windows.
- `idx_logs_sev_ts (severity, ts DESC, id DESC)` — severity equality + ordering.
- `idx_logs_msg_lower (lower(message))` — supports case-insensitive matching.

### API (`server/logsRepo.js`, `server/index.js`)
- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`,
  ordered by `ts DESC`. `limit` capped at 200. `severity` filters exactly,
  `q` is a case-insensitive substring; both combine and are applied in SQL.
  Invalid params (negative offset, limit over cap, unknown severity) → **400**.
  Exact `total` per filter is cached briefly so deep-offset windows on the same
  filter don't recount the corpus every scroll/keystroke.
- `GET /api/stats` → `{ total, bySeverity }` for the filter-bar badges.

## Frontend (`client/`)

- **Virtual scroller**: the scroll spacer is sized to `total * rowHeight`; only
  the rows intersecting the viewport (plus a small overscan) exist in the DOM,
  positioned with `transform: translateY(...)`. A fixed row pool is recycled.
- Rows are fetched **window-by-window** (200-row pages) and cached with LRU-ish
  eviction, so DOM and memory stay bounded at any scroll depth.
- **Debounced** search (never blocks the input); a monotonic filter token plus
  `AbortController` guarantees **stale responses never overwrite newer ones**.
- Changing a filter resets scroll, refetches `total`, and re-renders.
- Severity is color-coded; the header shows `N of <total>` under active filters.

## Measured budgets (100k corpus)

| Query | p95 |
|---|---|
| `limit=100` @ offset 0 / 50k / 99.9k | ~19 / ~25 / ~33 ms |
| severity-only @ deep offset | ~23 ms |
| selective substring | ~95 ms |
| non-selective substring | ~39 ms |
| severity + substring | ~18 ms |

First boot (with seed) < 60 s; subsequent boots < 10 s. No response ever
exceeds 200 rows.
