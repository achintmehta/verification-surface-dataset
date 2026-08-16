# Log Explorer

A greenfield client/server log explorer with a deterministic 100,000-row PGLite corpus, bounded windowed APIs, and a Vanilla JS virtualized table.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Frontend dev server: Vite default output (usually http://localhost:5173)

The first server boot creates `data/pglite`, seeds exactly 100,000 rows in batches, creates supporting indexes, and then serves requests. Later boots reuse the persisted corpus.

## API

- `GET /api/logs?offset=0&limit=100&severity=warn&q=timeout`
  - Returns `{ total, rows }`, ordered by `ts DESC, id DESC`.
  - `limit` must be 1..200.
  - `severity` may be `debug`, `info`, `warn`, or `error`.
  - `q` is a case-insensitive message substring filter.
- `GET /api/stats`
  - Returns total rows and per-severity counts.

## Notes

PGLite is the durable embedded database. On startup the API also builds a compact ordered in-process window store from the persisted corpus so deep offsets and substring-filtered windows remain within the explicit latency budgets while responses remain capped to the requested window.
