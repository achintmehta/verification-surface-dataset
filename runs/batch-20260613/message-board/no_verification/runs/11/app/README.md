# Realtime Message Board

A fast, local-first collaborative message board. Users post text messages and
every connected client sees updates instantly. Data is stored persistently on
local disk via an **embedded PGLite** PostgreSQL database, and realtime
synchronisation is handled with **Server-Sent Events (SSE)**.

No external database service required — PGLite runs directly inside the
Node.js process.

## Architecture

```
client (Vanilla JS + Vite)              server (Express + PGLite)
┌──────────────────────────┐            ┌───────────────────────────────┐
│ EventSource /api/stream  │ ◀───SSE────│ GET  /api/stream  (broadcast) │
│ fetch GET /api/messages  │ ◀──HTTP────│ GET  /api/messages (history)  │
│ fetch POST /api/messages │ ───HTTP───▶│ POST /api/messages (insert)   │
└──────────────────────────┘            │            │                  │
                                        │       PGLite (pgdata/)        │
                                        └───────────────────────────────┘
```

- **Decision 1 — Embedded PGLite:** Postgres-in-process, persisted to
  `server/pgdata/`. No separate DB to install or configure.
- **Decision 2 — SSE over WebSockets:** We only need one-way server→client
  pushes, so SSE keeps things simple over plain HTTP. Clients post messages
  with regular HTTP `POST` requests.
- **Decision 3 — Vanilla JS + Vite:** Minimal UI, tiny dependency tree, fast
  builds.

## Project structure

```
.
├── package.json          # root scripts (run both dev servers concurrently)
├── server/               # Express + PGLite + SSE backend
│   └── src/
│       ├── index.js      # Express app + routes
│       ├── db.js         # PGLite init + queries
│       └── sse.js        # SSE client registry + broadcast
└── client/               # Vanilla JS + Vite frontend
    ├── index.html
    └── src/
        ├── main.js
        └── style.css
```

## Getting started

Install all dependencies (root, server, and client):

```bash
npm run install:all
```

Run both the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite, proxies `/api` to the backend)
- Backend:  http://localhost:3001

Open the frontend URL in two browser tabs and watch messages appear in
real time across both.

## API

| Method | Path             | Description                                   |
| ------ | ---------------- | --------------------------------------------- |
| GET    | `/api/messages`  | Fetch full message history (initial state)    |
| POST   | `/api/messages`  | Create a message `{ "text": "hello" }`        |
| GET    | `/api/stream`    | SSE stream; emits `message` events on insert  |
| GET    | `/api/health`    | Health check + connected client count         |

## Production build

```bash
npm run build          # builds the client into client/dist
npm start              # runs the backend server
```

Serve `client/dist` with any static host and point its `/api` requests at the
running backend.

## Configuration

| Env var           | Default               | Description                        |
| ----------------- | --------------------- | ---------------------------------- |
| `PORT`            | `3001`                | Backend HTTP port                  |
| `PGLITE_DATA_DIR` | `server/pgdata`       | Directory PGLite persists data to  |
