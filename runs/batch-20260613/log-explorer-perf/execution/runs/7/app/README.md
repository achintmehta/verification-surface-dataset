# Log Explorer

A Node/Express + embedded PGLite backend and Vanilla JS/Vite frontend for exploring a deterministic 100,000-row log corpus with server-side windowing and a virtualized table.

## Run

```bash
npm install
npm run dev
```

Backend: http://localhost:3000
Frontend: http://localhost:5173

The first backend boot seeds `data/pglite` with exactly 100,000 deterministic rows. Subsequent boots reuse the database.

## API

- `GET /api/logs?offset=0&limit=100&severity=warn&q=cache`
- `GET /api/stats`
