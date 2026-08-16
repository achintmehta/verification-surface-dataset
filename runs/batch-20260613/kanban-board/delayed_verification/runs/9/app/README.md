# Collaborative Kanban Board

A lightweight multi-user Kanban board built with Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend (Vite): http://localhost:5173

For production-style serving:

```bash
npm run build
npm start
```

PGLite persists data under `./data/pglite`.
