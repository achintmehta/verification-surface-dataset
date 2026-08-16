# Log Explorer

A greenfield Node/Express + embedded PGLite backend and Vanilla JS/Vite frontend for exploring a deterministic 100,000-row log corpus with server-side windowing and a virtualized UI.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- UI: http://localhost:5173

The first server boot creates `./.pglite`, builds the schema/indexes, and seeds exactly 100,000 rows. Later boots detect the populated table and skip seeding.

## API

### `GET /api/logs`

Query params:

- `offset`: non-negative integer, default `0`
- `limit`: `1..200`, default `100`
- `severity`: optional one of `debug`, `info`, `warn`, `error`
- `q`: optional case-insensitive message substring

Returns:

```json
{ "total": 100000, "rows": [] }
```

Rows are ordered by `ts DESC, id DESC`; no response contains more than 200 rows.

### `GET /api/stats`

Returns total row count and per-severity counts for the filter badges.
