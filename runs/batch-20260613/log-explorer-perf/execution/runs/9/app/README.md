# Log Explorer

A client-server log explorer for a deterministic 100,000-row corpus.

## Run

```bash
npm run install:all
npm run dev
```

- API: http://localhost:3001
- UI: http://localhost:5173

The backend stores PGLite data in `server/pglite-data` by default. Set `PGLITE_DATA_DIR` to use another location.

## API

### `GET /api/logs`

Query params:

- `offset` non-negative integer, default `0`
- `limit` integer `1..200`, default `100`
- `severity` one of `debug|info|warn|error`
- `q` case-insensitive message substring

Returns `{ "total": number, "rows": [...] }`, ordered by `ts DESC, id DESC`.

### `GET /api/stats`

Returns total row count and counts per severity for filter badges.
