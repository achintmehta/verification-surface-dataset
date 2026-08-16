# Realtime Board

A lightweight, local-first collaborative message board. Post text messages and
see updates from every connected client instantly.

- **Backend**: Node.js + Express, with an **embedded [PGLite](https://pglite.dev)**
  PostgreSQL database persisted to the local filesystem.
- **Realtime**: **Server-Sent Events (SSE)** push new messages to all clients.
- **Frontend**: Vanilla JS bundled with **Vite**.

## Architecture

```
client (Vite, :5173)  ──HTTP──▶  POST /api/messages  ─┐
                                  GET  /api/messages   │  Express (:3001)
                      ◀──SSE────  GET  /api/stream  ◀──┘──▶ PGLite (server/pgdata)
```

When a client posts a message, the server inserts it into PGLite and then
broadcasts the new row over every open SSE connection.

## Getting started

Install dependencies for the root, server, and client:

```bash
npm run install:all
```

Run the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

The Vite dev server proxies `/api/*` requests to the Express backend, so the
frontend uses same-origin relative URLs.

## API

| Method | Path            | Description                                  |
| ------ | --------------- | -------------------------------------------- |
| GET    | `/api/messages` | Fetch full message history (oldest first).   |
| POST   | `/api/messages` | Create a message. Body: `{ "text": "..." }`. |
| GET    | `/api/stream`   | SSE stream of new messages.                  |
| GET    | `/api/health`   | Health check + connected SSE client count.   |

## Project layout

```
.
├── package.json        # root scripts (concurrently runs both apps)
├── server/             # Express + PGLite + SSE backend
│   └── src/
│       ├── index.js    # routes & server bootstrap
│       ├── db.js       # PGLite init + schema
│       └── sse.js      # SSE connection registry + broadcast
└── client/             # Vanilla JS + Vite frontend
    ├── index.html
    └── src/
        ├── main.js
        └── style.css
```

## Notes

- PGLite data is stored in `server/pgdata/` (gitignored) and persists across
  restarts.
- This app targets a single Node instance; PGLite is embedded in-process and is
  not designed for horizontal scaling.
