# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/) with a custom virtual scroller

## Quick Start

```bash
# Install all dependencies (root + workspaces)
npm install

# Start both backend (port 3001) and frontend dev server (port 5173)
npm run dev
```

Then open **http://localhost:5173** in your browser.

On first boot the server seeds 100,000 deterministic log rows into an embedded
PGLite database at `data/pglite/`. Subsequent boots detect the populated table
and skip seeding (< 10 s cold start after first seed).

## Architecture

### Backend (`server/`)

| File | Purpose |
|------|---------|
| `src/index.js` | Express app bootstrap, boot sequence |
| `src/db.js` | PGLite singleton, persisted to `data/pglite/` |
| `src/schema.js` | Table DDL + indexes |
| `src/seed.js` | Deterministic 100k-row seed (batched inserts) |
| `src/routes/logs.js` | `GET /api/logs` — windowed, filtered query |
| `src/routes/stats.js` | `GET /api/stats` — per-severity counts |

### Frontend (`client/`)

| File | Purpose |
|------|---------|
| `src/main.js` | App bootstrap, filter wiring, stats badges |
| `src/virtualScroller.js` | Virtual scroller — only visible rows in DOM |
| `src/api.js` | Typed fetch wrappers with AbortController support |
| `src/style.css` | Dark-theme UI |

## API

### `GET /api/logs`

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `offset` | integer ≥ 0 | 0 | Row offset in the ordered result set |
| `limit` | integer 1–200 | 100 | Rows to return; hard-capped at 200 |
| `severity` | `debug`\|`info`\|`warn`\|`error` | — | Exact match filter |
| `q` | string | — | Case-insensitive message substring |

**Response**: `{ total: number, rows: Row[] }`

Returns 400 for invalid parameters (negative offset, limit > 200, unknown severity).

### `GET /api/stats`

**Response**: `{ total: number, bySeverity: { debug, info, warn, error } }`

### `GET /api/health`

**Response**: `{ status: "ok" }`

## Performance Budgets

| Scenario | Budget |
|----------|--------|
| `GET /api/logs?limit=100` at offset 0, 50000, 99900 | < 150 ms p95 |
| Severity-only filter at deep offset | < 300 ms p95 |
| Selective substring filter at deep offset | < 300 ms p95 |
| Non-selective substring filter at deep offset | < 300 ms p95 |
| First boot (including full seed) | < 60 s |
| Subsequent boots (no reseed) | < 10 s |
| Max rows in any single response | 200 |
| Max DOM rows at any scroll position | ~100 |

## Index Strategy

```sql
-- All-rows ordering (ORDER BY ts DESC)
CREATE INDEX idx_logs_ts ON logs (ts DESC);

-- Severity-filtered queries (WHERE severity = ? ORDER BY ts DESC)
CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);

-- Case-insensitive substring search (lower(message) LIKE '%q%')
CREATE INDEX idx_logs_message_lower ON logs (lower(message));

-- Combined severity + substring
CREATE INDEX idx_logs_severity_message ON logs (severity, lower(message));
```

## Seed Corpus

- **100,000 rows**, fully deterministic (same rows on every boot)
- **Timestamps**: uniformly distributed over a 30-day window (2024-01-01 to 2024-01-31)
- **Severity**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **Services**: 8 services (auth, api-gateway, user, payment, notification, inventory, search, analytics)
- **Messages**: 24 templates with variable fragments — mix of selective (rare terms) and non-selective (common terms) for realistic substring search benchmarking
- **Batch size**: 2,000 rows per INSERT for fast seeding
