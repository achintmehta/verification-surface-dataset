# Log Explorer

A greenfield client-server log explorer with a deterministic 100,000 row embedded PGLite corpus and a vanilla JS virtualized UI.

## Scripts

- `npm start` / `npm run server` - start the Express + PGLite API on port 3000.
- `npm run client` - start the Vite frontend on port 5173, proxying `/api` to the backend.
- `npm run dev` - run both servers together.

## API

- `GET /api/logs?offset=0&limit=100&severity=warn&q=timeout`
  - `limit` is capped/rejected above 200.
  - Results are ordered by `ts DESC, id DESC` and include `{ total, rows }`.
- `GET /api/stats` returns total and per-severity counts.

PGLite data is stored under `data/pglite` and is seeded only when the table is empty or incomplete.
