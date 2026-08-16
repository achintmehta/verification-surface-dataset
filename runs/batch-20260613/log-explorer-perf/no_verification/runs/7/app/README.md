# Log Explorer

A greenfield Node/Express + PGLite backend and Vanilla JS/Vite frontend for exploring a deterministic 100,000-row log corpus.

## Run

```bash
npm install
npm run dev
```

- Backend: <http://localhost:3000>
- Frontend: <http://localhost:5173>

The first backend boot seeds exactly 100,000 rows into `.pglite-data`. Later boots reuse that embedded database and skip reseeding.

## API

`GET /api/logs?offset=0&limit=100&severity=error&q=timeout`

Returns `{ total, rows }`, sorted by `ts DESC`, with `limit` validated at a maximum of 200.

`GET /api/stats`

Returns total and per-severity counts for the filter badges.
