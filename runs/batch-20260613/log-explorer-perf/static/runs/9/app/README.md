# Log Explorer

A traditional client/server log explorer with an embedded PGLite database, deterministic 100,000-row seed corpus, windowed query API, and vanilla JS virtualized table.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Vite UI: http://localhost:5173

The first server boot creates `.pglite-data` and seeds exactly 100,000 rows. Later boots reuse the persisted corpus and skip reseeding.

## API

### `GET /api/logs`

Query params:

- `offset` non-negative integer, default `0`
- `limit` integer `1..200`, default `100`
- `severity` optional: `debug`, `info`, `warn`, or `error`
- `q` optional case-insensitive message substring

Returns:

```json
{ "total": 100000, "rows": [] }
```

Rows are ordered by `ts DESC, id DESC`; responses are capped to at most 200 rows and invalid parameters return HTTP 400.

### `GET /api/stats`

Returns total rows and per-severity counts for filter badges.
