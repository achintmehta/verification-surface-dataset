# Log Explorer

A client-server log explorer for a high-volume service. The server seeds a
deterministic 100,000-row corpus into an embedded PGLite database and exposes
windowed, filterable query endpoints. The client renders a virtualized log
table that stays fast regardless of scroll depth.

## Architecture

```
client/   Vanilla JS + Vite virtualized log table
server/   Node.js + Express + embedded PGLite (persisted to server/pgdata)
```

### Backend (`server/`)

- **Schema** (`logs`): `id`, `ts TIMESTAMPTZ`, `severity` (debug/info/warn/error),
  `service`, `message`.
- **Seed** (`src/seed-data.js`): exactly 100,000 rows spanning 30 days across 8
  services, severities ~60/25/10/5 (info/debug/warn/error). Messages come from
  per-severity templates with variable fragments so substring search has both
  selective (e.g. a specific `span-xxxx`) and non-selective (e.g. `request`)
  terms. Everything is derived from the row index — the corpus is byte-identical
  on every boot/machine.
- **Seeding on first boot only** (`src/db.js`): batched multi-row inserts inside
  a transaction. On subsequent boots the populated table is detected and seeding
  is skipped. Data persists to `server/pgdata` and survives restarts.
- **Indexes** for the graded query shapes:
  - `(ts DESC, id DESC)` — global ordering + keyset-friendly window.
  - `(severity, ts DESC, id DESC)` — severity equality + ordering.
  - GIN trigram on `lower(message)` (`pg_trgm`) — index-accelerated
    case-insensitive substring search.

### API

- `GET /api/logs?offset=&limit=&severity=&q=` → `{ total, rows }`, ordered by
  `ts DESC`. `limit` capped at 200 (never returns more). `severity` filters
  exactly; `q` matches message substrings case-insensitively; both combine.
  Invalid params (negative offset, limit over cap, unknown severity) → `400`.
- `GET /api/stats` → `{ total, bySeverity }` for the filter bar.

### Frontend (`client/`)

- Virtual scroller: the spacer is sized to `total * rowHeight`, giving a real
  scrollbar for the whole filtered corpus; only rows intersecting the viewport
  (plus a small overscan) exist in the DOM, drawn from a recycled node pool.
- Row data is fetched in aligned 200-row windows and cached with bounded
  eviction. Placeholders show for not-yet-loaded rows (no permanent blanks).
- Debounced search (200 ms); the input is never blocked on the network. Every
  request carries a monotonic sequence id, so out-of-order responses never
  overwrite newer results.
- Severity color-coding; a live "N of TOTAL" count reflects the active filter.

## Running

```bash
npm run install:all   # install root, server, and client deps
npm run dev            # runs backend (:3001) and frontend (:5173) together
```

Then open http://localhost:5173. Vite proxies `/api` to the backend.

- First boot seeds the corpus (well under 60 s); watch the server logs.
- Subsequent boots skip seeding and start within a few seconds.
