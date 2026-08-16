# Realtime Message Board

A local-first collaborative message board. The backend is a Node.js + Express
server with an **embedded PGLite** PostgreSQL database, and real-time updates are
pushed to every connected browser tab via **Server-Sent Events (SSE)**. The
frontend is a lightweight Vanilla JS app built with Vite.

## Architecture

```
client/  → Vanilla JS + Vite SPA (message list + composer, EventSource stream)
server/  → Express API + embedded PGLite + SSE hub
```

- `GET  /api/messages` — fetch historical messages (initial state)
- `POST /api/messages` — insert a new message (broadcasts to all SSE clients)
- `GET  /api/stream`   — long-lived SSE connection delivering `message` events
- `GET  /api/health`   — health check (also reports active SSE client count)

Data is persisted to disk by PGLite under `server/data/pgdata`.

## Getting started

Install dependencies for the root, server, and client:

```bash
npm run install:all
```

Run both the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend (Vite): http://localhost:5173
- Backend (Express): http://localhost:3001

The Vite dev server proxies `/api/*` to the backend, so the frontend uses
same-origin relative URLs (which also keeps the SSE connection simple).

## Configuration

Server environment variables (all optional):

| Variable      | Default                  | Description                          |
| ------------- | ------------------------ | ------------------------------------ |
| `PORT`        | `3001`                   | Express listen port                  |
| `DATA_DIR`    | `server/data/pgdata`     | PGLite persistence directory         |
| `CORS_ORIGIN` | `*`                      | Allowed CORS origin                  |

## Production build

```bash
npm run build      # builds the client into client/dist
npm start          # runs the API server
```

Serve `client/dist` with any static file server (or behind the API) and point
its `/api` requests at the running backend.
