# Collaborative Kanban Board

A lightweight real-time collaborative Kanban board built with:

- Node.js + Express
- Embedded PGLite persisted to local disk
- Server-Sent Events for real-time convergence
- Vanilla JavaScript + Vite frontend

## Development

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

The Vite dev server proxies `/api/*` requests to the backend. PGLite data is stored in `./data/pglite` by default.

## Production-style run

```bash
npm install
npm run build
npm start
```

The Express server serves the built frontend from `frontend/dist` when present.
