# Collaborative Kanban Board

A lightweight multi-user Kanban board built with Node.js, Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3001
- Frontend: http://localhost:5173

The PGLite database persists to `.pglite/` by default. Set `PGLITE_DATA_DIR` to override the storage path.
