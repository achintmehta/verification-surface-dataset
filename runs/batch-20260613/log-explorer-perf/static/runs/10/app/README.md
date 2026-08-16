# Log Explorer

A greenfield client/server log explorer for a deterministic 100,000-row corpus.

## Run

```bash
npm install
npm run dev
```

- API: `http://localhost:3000`
- UI: Vite dev server URL printed by Vite, usually `http://localhost:5173`

## API

### `GET /api/logs`

Query params:

- `offset`: non-negative integer, default `0`
- `limit`: `1..200`, default `100`; values over 200 are rejected with HTTP 400
- `severity`: optional exact filter, one of `debug`, `info`, `warn`, `error`
- `q`: optional case-insensitive message substring filter

Returns:

```json
{ "total": 100000, "rows": [] }
```

Rows are ordered by `ts DESC, id DESC` and include `id`, `ts`, `severity`, `service`, and `message`.

### `GET /api/stats`

Returns total row count and per-severity counts for filter badges.

## Implementation notes

- PGLite database is persisted in `./.pglite-data` and seeded only when the `logs` table is missing or incomplete.
- Seeding is deterministic and batched in a single transaction.
- Indexes are created for timestamp ordering, severity + timestamp ordering, and lower-cased message filtering support.
- The client uses fixed-height virtual rows. The DOM contains only the viewport rows plus overscan, while the scrollbar height reflects the server-provided `total`.
- Filter requests are debounced and in-flight requests are aborted; stale responses are ignored using a monotonically increasing request sequence.
