# Collaborative Kanban Board

A small traditional client-server Kanban board with real-time convergence.

- Node.js/Express backend
- Embedded PGLite persisted under `./data/pglite`
- Server-Sent Events for real-time updates
- Vanilla JS + Vite frontend
- Server-authoritative fractional ordering with collision renormalization

## Run

```bash
npm install
npm run dev
```

The backend defaults to `http://localhost:3001` and the Vite frontend to `http://localhost:5173`.

For production-style use:

```bash
npm install
npm run client:build
npm start
```

The Express server will serve `client/dist` if it exists.
