# Collaborative Kanban Board

A lightweight real-time multi-user Kanban board using Express, embedded PGLite, Server-Sent Events, and a vanilla JavaScript/Vite frontend.

## Development

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API/SSE: http://localhost:3000

## Production-style run

```bash
npm install
npm run build
npm start
```

The server persists data in `.pglite-data/` and serves the built frontend from `dist/`.
