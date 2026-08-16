# Realtime Message Board

A lightweight, local-first collaborative message board. Post text messages and
see updates from all connected clients **instantly**, with no external database
service required.

## Architecture

```
┌──────────────┐   POST /api/messages    ┌─────────────────────────┐
│              │ ──────────────────────► │                         │
│   Browser    │   GET  /api/messages    │   Node.js / Express     │
│ (Vanilla JS) │ ◄──── history ───────── │                         │
│  EventSource │   GET  /api/stream      │   ┌──────────────────┐  │
│              │ ◄═══ SSE broadcasts ════ │   │  PGLite (WASM)   │  │
└──────────────┘                         │   │  → ./pgdata disk │  │
                                         │   └──────────────────┘  │
                                         └─────────────────────────┘
```

- **Backend** — Express server with an embedded [PGLite](https://github.com/electric-sql/pglite)
  PostgreSQL database persisting to `server/pgdata/`. New messages are pushed to
  all clients via **Server-Sent Events (SSE)**.
- **Frontend** — Vanilla JS built with Vite. Uses `fetch` for history/posting
  and `EventSource` for live updates.

## Project structure

```
.
├── package.json          # root: dev scripts (runs server + client concurrently)
├── server/               # Express + PGLite backend
│   ├── package.json
│   └── src/
│       ├── index.js      # Express app, routes
│       ├── db.js         # PGLite init + queries
│       └── sse.js        # SSE connection manager + broadcast
└── client/               # Vanilla JS + Vite frontend
    ├── package.json
    ├── vite.config.js     # dev proxy → backend
    ├── index.html
    └── src/
        ├── main.js
        └── style.css
```

## Getting started

Install all dependencies (root, server, client):

```bash
npm run install:all
```

Run both the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite, proxies `/api` → backend)
- Backend:  http://localhost:3001

## API

| Method | Path            | Description                                   |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/api/messages` | Fetch all messages (chronological).           |
| POST   | `/api/messages` | Create a message. Body: `{ "text": "hi" }`.   |
| GET    | `/api/stream`   | SSE stream. Emits `message` events.           |

## Production

Build the frontend and serve it from the Express backend:

```bash
npm run build      # outputs client/dist
npm start          # Express serves API + static client at :3001
```

## Notes

- PGLite is tied to a single Node process; horizontal scaling is out of scope.
- No authentication — intended as a local/demo collaborative tool.
