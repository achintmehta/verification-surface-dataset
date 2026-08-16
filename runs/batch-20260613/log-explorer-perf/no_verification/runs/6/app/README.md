# Log Explorer

A high-volume client/server log explorer backed by embedded PGLite and a virtualized vanilla JavaScript UI.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- UI: http://localhost:5173

The first server boot seeds exactly 100,000 deterministic log rows into `.pgdata`; later boots reuse the database.
