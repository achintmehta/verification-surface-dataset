# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:
- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL)
- **Frontend**: Vanilla JS + Vite with virtualized scrolling

## Quick Start

```bash
# Install all dependencies
npm run install:all

# Run both backend and frontend dev servers
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

## Architecture

### Backend
- **PGLite** embedded database stored in `./data/pglite`
- **100,000 deterministic log entries** seeded on first boot (skipped on subsequent boots)
- **Indexes**: `(ts DESC)`, `(severity, ts DESC)`, `(service, ts DESC)`, GIN trigram on `message`
- **Windowed API**: `GET /api/logs?offset=&limit=&severity=&q=` — never returns more than 200 rows

### Frontend
- **Virtual scroller**: only ~100 DOM rows exist regardless of corpus size
- **Debounced search**: 300ms debounce, AbortController cancels stale requests
- **Severity color-coding**: error/warn/info/debug visually distinct

## API

### `GET /api/logs`
| Param | Type | Description |
|-------|------|-------------|
| `offset` | integer ≥ 0 | Row offset (default: 0) |
| `limit` | integer 1–200 | Rows to return (default: 100) |
| `severity` | string | Filter: `debug`, `info`, `warn`, `error` |
| `q` | string | Case-insensitive message substring |

Returns: `{ total: number, rows: Array<{id, ts, severity, service, message}> }`

### `GET /api/stats`
Returns: `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets

| Query | Budget |
|-------|--------|
| Unfiltered windowed query (any offset) | < 150ms p95 |
| Filtered query (severity or substring, deep offset) | < 300ms p95 |
| First boot (including seed) | < 60s |
| Subsequent boots | < 10s |
| Max rows per response | 200 |

## Data Model

```sql
CREATE TABLE logs (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('debug','info','warn','error')),
  service  TEXT NOT NULL,
  message  TEXT NOT NULL
);
```

Severity distribution: ~60% info, ~25% debug, ~10% warn, ~5% error  
Services: 8 (api-gateway, auth-service, user-service, order-service, payment-service, inventory-service, notification-service, analytics-service)  
Time range: 30 days (2024-01-01 to 2024-01-31)
