# Log Explorer

A high-performance log explorer for a 100,000-row corpus, built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/) with a virtualized scroll table

## Quick Start

```bash
# Install dependencies
npm install

# Start both backend (port 3001) and frontend dev server (port 5173)
npm run dev
```

Then open **http://localhost:5173** in your browser.

On first boot the server seeds 100,000 deterministic log rows into an embedded
PGLite database at `./data/pglite/`. Subsequent boots detect the populated table
and skip seeding (< 10 s boot time).

## Architecture

### Backend (`server/`)

| File | Purpose |
|------|---------|
| `index.js` | Express app, boot sequence |
| `db.js` | PGLite init, schema, indexes, seed |
| `routes/logs.js` | `GET /api/logs` – windowed, filterable query |
| `routes/stats.js` | `GET /api/stats` – aggregate counts |

**Schema**

```sql
CREATE TABLE logs (
  id       BIGSERIAL    PRIMARY KEY,
  ts       TIMESTAMPTZ  NOT NULL,
  severity TEXT         NOT NULL,  -- debug|info|warn|error
  service  TEXT         NOT NULL,
  message  TEXT         NOT NULL
);
```

**Indexes**

```sql
-- Unfiltered ORDER BY ts DESC
CREATE INDEX idx_logs_ts ON logs (ts DESC);

-- Severity filter + ORDER BY ts DESC
CREATE INDEX idx_logs_severity_ts ON logs (severity, ts DESC);

-- Substring search via pg_trgm GIN index
CREATE INDEX idx_logs_message_trgm ON logs USING GIN (message gin_trgm_ops);
```

### Frontend (`client/`)

| File | Purpose |
|------|---------|
| `index.html` | App shell |
| `src/main.js` | Wires filters, search, stats |
| `src/virtualScroller.js` | Virtual scroll engine |
| `src/api.js` | Fetch helpers |
| `src/style.css` | Dark-theme styles |

The virtual scroller maintains a fixed DOM pool of ~30 rows regardless of corpus
size. The scroll spacer height = `total × 36px` gives the scrollbar its full
range. Rows are repositioned absolutely within a sticky viewport div.

## API

### `GET /api/logs`

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `offset` | int ≥ 0 | 0 | Row offset |
| `limit` | int 1–200 | 100 | Rows to return |
| `severity` | string | – | Filter: `debug\|info\|warn\|error` |
| `q` | string | – | Case-insensitive message substring |

**Response**: `{ total: number, rows: [{id, ts, severity, service, message}] }`

### `GET /api/stats`

**Response**: `{ total: number, bySeverity: { debug, info, warn, error } }`

## Performance Budgets

| Scenario | Budget |
|----------|--------|
| Windowed query at any offset (limit=100) | < 150 ms p95 |
| Filtered query (severity or substring) at deep offset | < 300 ms p95 |
| First boot including full seed | < 60 s |
| Subsequent boots (no reseed) | < 10 s |
| Max rows per response | 200 |
| DOM rows at any scroll position | ≤ ~100 |

## Corpus

- **100,000 rows** seeded deterministically (same data every time)
- **30-day time range**: 2024-01-01 → 2024-01-31
- **8 services**: auth-service, api-gateway, user-service, payment-service, notification-service, search-service, analytics-service, storage-service
- **Severity distribution**: ~60% debug, ~25% info, ~10% warn, ~5% error
- **Messages**: drawn from 25 templates with variable fragments for selective and non-selective substring search
