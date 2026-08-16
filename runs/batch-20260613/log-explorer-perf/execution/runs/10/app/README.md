# Log Explorer

A greenfield client/server log explorer with a deterministic 100,000-row PGLite corpus, Express windowed APIs, and a Vite/Vanilla JS virtualized table.

## Run

```bash
npm install
npm run dev
```

- API: `http://localhost:3000`
- UI: `http://localhost:5173`

The first API boot seeds `data/pglite` with exactly 100,000 log rows. Later boots reuse the embedded database and skip reseeding.

## API

- `GET /api/logs?offset=0&limit=100&severity=error&q=timeout`
  - ordered by `ts DESC, id DESC`
  - `limit` must be `1..200`
  - `severity` is one of `debug`, `info`, `warn`, `error`
  - returns `{ total, rows }`
- `GET /api/stats`
  - returns total and severity counts for badges
