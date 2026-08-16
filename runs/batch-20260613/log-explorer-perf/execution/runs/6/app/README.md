# Log Explorer

A greenfield Node/Express + embedded PGLite backend and Vanilla JS/Vite frontend for exploring a deterministic 100,000-row log corpus with server-side windowing and a virtualized table.

## Run

```bash
npm install
npm run dev
```

- API: <http://localhost:3001>
- UI: <http://localhost:5173>

The first API boot creates `pgdata/`, seeds exactly 100,000 deterministic rows in batches, creates indexes, and then serves requests. Later boots detect the populated table and skip reseeding.

## Useful endpoints

```bash
curl 'http://localhost:3001/api/stats'
curl 'http://localhost:3001/api/logs?offset=99900&limit=100'
curl 'http://localhost:3001/api/logs?severity=error&q=rare-needle&offset=0&limit=100'
```

`/api/logs` rejects invalid offsets, limits over 200, and unknown severities with HTTP 400.
