# Log Explorer

A greenfield Node/Express + embedded PGLite + Vanilla JS/Vite log explorer. The API seeds exactly 100,000 deterministic log rows on first boot and returns bounded windows for a virtualized client table.

## Run

```bash
npm install
npm run dev      # API on :3000, Vite on :5173
# or
npm start        # API only
```

## API

- `GET /api/logs?offset=0&limit=100&severity=error&q=timeout`
  - ordered by `ts DESC, id DESC`
  - `limit` must be 1..200
  - `severity` is one of `debug`, `info`, `warn`, `error`
  - `q` is a case-insensitive message substring
- `GET /api/stats`

PGLite data is persisted under `data/pglite`; subsequent boots skip seeding when 100,000 rows already exist.
