# Log Explorer

A greenfield client/server log explorer for a deterministic 100,000-row corpus.

## Run

```bash
npm install
npm run server
npm run client
```

Or start both in one shell with `npm run dev`.

- API: http://localhost:3000
- UI: http://localhost:5173

## API

- `GET /api/logs?offset=0&limit=100&severity=warn&q=timeout`
  - Returns `{ total, rows }` sorted by `ts DESC, id DESC`.
  - `limit` must be 1..200; larger values are rejected with 400.
  - `severity` is one of `debug|info|warn|error`.
  - `q` is a case-insensitive message substring filter.
- `GET /api/stats` returns total and per-severity counts.

On first boot the server creates a PGLite database in `pglite-data/`, seeds exactly 100,000 rows in batches, and creates indexes. Subsequent boots detect the corpus and skip reseeding.
