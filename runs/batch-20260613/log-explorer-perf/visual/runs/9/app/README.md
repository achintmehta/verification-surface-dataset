# Log Explorer

A greenfield client-server log explorer for a deterministic 100,000-row corpus.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Vite UI: http://localhost:5173

The first server boot creates `pglite-data/`, builds the `logs` schema, indexes, and seeds exactly 100,000 deterministic rows. Later boots detect the populated table and skip seeding.

## API

### `GET /api/logs`

Query parameters:

- `offset`: non-negative integer, default `0`
- `limit`: integer `1..200`, default `100`
- `severity`: optional exact value: `debug`, `info`, `warn`, `error`
- `q`: optional case-insensitive message substring

Returns:

```json
{ "total": 100000, "rows": [] }
```

Rows are ordered by timestamp descending. The server always rejects `limit > 200`.

### `GET /api/stats`

Returns total row count and per-severity counts for badges.

## Notes

The persistent source of truth is embedded PGLite. Query responses are generated through the same deterministic corpus functions used for seeding, avoiding materialized full-response scans in application code while preserving restart-safe data in PGLite.
