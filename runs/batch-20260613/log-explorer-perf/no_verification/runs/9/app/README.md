# Log Explorer

A greenfield client/server log explorer with a deterministic 100,000-row PGLite corpus, capped windowed API responses, server-side filters, and a vanilla JS virtualized UI.

## Run

```bash
npm install
npm run dev
```

This starts:

- API: `http://localhost:3000`
- Vite client: `http://localhost:5173`

Install dependencies in subprojects if your environment does not do workspace-style root installs:

```bash
npm --prefix server install
npm --prefix client install
```

## API

- `GET /api/logs?offset=0&limit=100&severity=error&q=timeout`
  - `limit` is validated and capped by rejection at 200.
  - `severity` must be one of `debug`, `info`, `warn`, `error` when present.
  - Returns `{ total, rows }`, ordered by descending timestamp.
- `GET /api/stats`
  - Returns total and per-severity counts for badges.

The first server boot creates `server/data/pglite`, seeds exactly 100,000 deterministic rows in batches, and creates indexes for timestamp ordering, severity+timestamp ordering, and lower-case message lookup support. Subsequent boots detect the populated corpus and skip reseeding.

## UI

The client uses a fixed-height virtual row pool. The scrollbar height is derived from the exact filtered total, while the DOM contains only visible rows plus overscan (bounded below 100 rows). Search is debounced and in-flight requests are aborted so stale responses cannot overwrite newer filters.
