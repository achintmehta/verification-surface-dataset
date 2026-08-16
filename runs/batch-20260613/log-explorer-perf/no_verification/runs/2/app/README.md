# Log Explorer

A high-volume log explorer with a virtualized frontend and a PGLite-backed server.
Handles 100,000 log entries with windowed queries, severity/substring filters, and
a virtual scroller that keeps the DOM bounded regardless of corpus size.

## Architecture

```
client/          Vanilla JS + Vite frontend
  src/
    main.js            App bootstrap, filter wiring, debounced search
    api.js             Fetch helpers (cancellable via AbortController)
    virtualScroller.js DOM virtualization (only visible rows in DOM)
    style.css          Dark-theme UI

server/          Node.js + Express + PGLite backend
  src/
    index.js           Express server entry point
    db.js              PGLite init, schema creation, seed detection
    seed.js            Deterministic 100k-row seed (batch inserts)
    routes/
      logs.js          GET /api/logs  (windowed, filtered)
      stats.js         GET /api/stats (total + per-severity counts)

data/            PGLite database files (created on first boot)
```

## Quick Start

```bash
# Install all dependencies (root + workspaces)
npm install

# Start both servers concurrently (backend :3001, frontend :5173)
npm run dev
```

Open http://localhost:5173 in your browser.

**First boot** seeds 100,000 rows into PGLite — expect 10–60 seconds.
**Subsequent boots** detect the populated table and skip seeding (< 10 seconds).

## API

### `GET /api/logs`

Returns a window of log rows ordered by timestamp descending.

| Param      | Type    | Default | Constraints                        |
|------------|---------|---------|------------------------------------|
| `offset`   | integer | `0`     | ≥ 0                                |
| `limit`    | integer | `100`   | 1–200                              |
| `severity` | string  | —       | `debug` \| `info` \| `warn` \| `error` |
| `q`        | string  | —       | Case-insensitive message substring |

**Response:**
```json
{
  "total": 100000,
  "rows": [
    {
      "id": 99999,
      "ts": "2024-01-30T23:58:12.345Z",
      "severity": "info",
      "service": "api-gateway",
      "message": "User u1234 logged in from IP 192.168.1.1 using POST"
    }
  ]
}
```

**Errors:** `400` for invalid params, `500` for server errors.

### `GET /api/stats`

```json
{
  "total": 100000,
  "bySeverity": {
    "debug": 60012,
    "info":  24998,
    "warn":   9995,
    "error":  4995
  }
}
```

## Performance Design

### Server-side

- **Batch inserts**: 2,000 rows per INSERT statement → full seed in < 60s
- **Indexes**:
  - `idx_logs_ts` on `(ts DESC)` — unfiltered ordering
  - `idx_logs_severity_ts` on `(severity, ts DESC)` — severity-filtered queries
  - `idx_logs_message_lower` on `lower(message)` — substring search fallback
  - `idx_logs_message_trgm` GIN trigram index (if `pg_trgm` available) — fast ILIKE
- **Windowed queries**: `LIMIT`/`OFFSET` with indexed ordering; deep offsets are
  fast because the planner uses the index to skip rows without scanning them

### Client-side

- **Virtual scroller**: only `~30–50` DOM rows exist at any time regardless of
  corpus size; scroll height is set to `total × 36px` to create the full range
- **Debounced search**: 250ms debounce; input is never blocked on queries
- **AbortController**: stale in-flight requests are cancelled; out-of-order
  responses are discarded via a monotonic sequence counter
- **Prefetch**: the scroller triggers a new fetch when the visible window
  approaches the edge of the loaded buffer, preventing blank regions

## Corpus Design

100,000 deterministic rows spanning 30 days:
- **8 services**: auth, api-gateway, user, payment, notification, inventory, search, analytics
- **Severity distribution**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **24 message templates** with variable fragments providing:
  - Selective terms (e.g. specific order IDs, trace IDs) — few matches
  - Non-selective terms (e.g. "user", "error", "query") — many matches
- All values derived from row index via deterministic hash → identical corpus across restarts

## Performance Budgets

| Scenario                                    | Budget  |
|---------------------------------------------|---------|
| `GET /api/logs?limit=100` at offset 0       | < 150ms |
| `GET /api/logs?limit=100` at offset 50,000  | < 150ms |
| `GET /api/logs?limit=100` at offset 99,900  | < 150ms |
| Severity-only filter at deep offset         | < 300ms |
| Selective substring at deep offset          | < 300ms |
| Non-selective substring at deep offset      | < 300ms |
| First boot (including full seed)            | < 60s   |
| Subsequent boots (no reseed)                | < 10s   |
| Max rows in any single response             | ≤ 200   |
