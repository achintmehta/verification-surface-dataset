# Log Explorer

Node/Express + embedded PGLite backend with a Vanilla JS/Vite virtualized frontend.

## Run

```bash
npm install
npm run dev
```

Backend: http://localhost:3000
Frontend: http://localhost:5173

The first backend boot creates `pglite-data/`, seeds exactly 100,000 deterministic rows in batches, creates indexes, and starts serving. Later boots reuse the persisted database and skip seeding.

## API

- `GET /api/logs?offset=0&limit=100&severity=error&q=timeout`
  - `limit` must be 1..200; offset must be non-negative.
  - Returns `{ total, rows }`, sorted by `ts DESC, id DESC`.
- `GET /api/stats`
  - Returns total and per-severity counts.
