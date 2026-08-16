# Log Explorer

A high-performance log explorer for a 100,000-row corpus. Built with Node.js + Express + PGLite (embedded PostgreSQL) on the backend, and Vanilla JS + Vite with a virtualized table on the frontend.

## Architecture

### Backend (`server/`)
- **Express** HTTP server with CORS
- **PGLite** embedded PostgreSQL — no external database required
- **Deterministic seed**: 100,000 log rows generated on first boot using an LCG RNG; subsequent boots skip seeding
- **Windowed query API**: `GET /api/logs` returns at most 200 rows per request with server-side filtering and ordering
- **Indexes**: `(ts DESC, id DESC)` for unfiltered ordering; `(severity, ts DESC, id DESC)` for severity-filtered queries

### Frontend (`client/`)
- **Virtual scroller**: only the rows intersecting the viewport (+ overscan) exist in the DOM — bounded at ~100 DOM rows regardless of corpus size
- **Window cache**: recently fetched windows are cached client-side to avoid redundant requests on back-scroll
- **Debounced search**: 250 ms debounce; in-flight requests are cancelled via `AbortController` when filters change
- **Stale-response guard**: each fetch carries a sequence number; out-of-order responses are discarded

## Quick Start

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

## API

### `GET /api/logs`
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `offset` | int ≥ 0 | 0 | Row offset |
| `limit` | int 1–200 | 100 | Rows to return |
| `severity` | debug\|info\|warn\|error | — | Filter by severity |
| `q` | string | — | Case-insensitive message substring |

Returns `{ total: number, rows: Row[] }` ordered by `ts DESC, id DESC`.

### `GET /api/stats`
Returns `{ total: number, bySeverity: { debug, info, warn, error } }`.

## Performance Budgets

| Query | Budget |
|-------|--------|
| `GET /api/logs?limit=100` at offset 0, 50000, 99900 | < 150 ms p95 |
| Severity-only, selective substring, non-selective substring at deep offsets | < 300 ms p95 |
| First boot (including full 100k seed) | < 60 s |
| Subsequent boots (no reseeding) | < 10 s |
| Max rows in any single response | 200 |

## Corpus

- **100,000 rows** spanning 30 days (2024-01-01 → 2024-01-31)
- **8 services**: api-gateway, auth-service, user-service, order-service, payment-service, notification-service, inventory-service, analytics-service
- **Severity distribution**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **Messages**: drawn from 26 templates with variable fragments (user IDs, IPs, durations, etc.) providing both selective and non-selective search terms
