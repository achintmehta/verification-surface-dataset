# Realtime Board

A lightweight, local-first message board built with an embedded
[PGLite](https://pglite.dev/) database and **Server-Sent Events (SSE)** for
real-time updates. No external database service required.

## Architecture

- **Backend** — Node.js + Express. Embedded PGLite persists messages to
  `./data/pgdata` on disk. New messages are broadcast to all connected clients
  over an SSE stream.
- **Frontend** — Vanilla JS bundled with Vite. Loads message history, listens
  for live updates via `EventSource`, and posts new messages with `fetch`.

## Endpoints

| Method | Path            | Description                                   |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/api/messages` | Fetch full message history (oldest first).    |
| POST   | `/api/messages` | Create a message `{ text }`; broadcasts it.   |
| GET    | `/api/stream`   | SSE stream of new messages (`event: message`).|

## Getting started

```bash
npm install
npm run dev
```

This runs both the Express backend (`:3000`) and the Vite dev server
(`:5173`) concurrently. Open the Vite URL in multiple tabs to see messages
sync in real time. Vite proxies `/api/*` to the backend.

## Production

```bash
npm run build   # build the static frontend into dist/
npm start       # run the backend server
```

When running in production you can serve the built `dist/` directory with any
static host and point it at the backend's `/api` routes.
