# Collaborative Kanban Board

A small client-server collaborative Kanban application using Express, embedded PGLite, Server-Sent Events, and a vanilla JavaScript/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

PGLite persists data under `./pgdata` by default. Override with `DATABASE_DIR`.
