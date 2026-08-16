# Log Explorer

A greenfield client-server log explorer that seeds 100,000 deterministic rows into embedded PGLite and exposes a windowed API consumed by a vanilla JS/Vite virtualized table.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- UI: http://localhost:5173

The first server boot creates `pglite-data/`, seeds exactly 100,000 rows in batches, creates indexes, and then starts serving. Later boots reuse the persisted corpus.

## API

### `GET /api/logs?offset=&limit=&severity=&q=`

Returns rows ordered by `ts DESC, id DESC`:

```json
{ "total": 100000, "rows": [] }
```

- `offset`: non-negative integer, default `0`
- `limit`: integer `1..200`, default `100`
- `severity`: optional `debug`, `info`, `warn`, or `error`
- `q`: optional case-insensitive message substring

Invalid parameters return `400`. Responses are capped at 200 rows.

### `GET /api/stats`

Returns total and per-severity counts for filter badges.
