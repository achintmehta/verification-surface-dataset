# Realtime Board

A local-first, realtime message board built with an embedded
[PGLite](https://github.com/electric-sql/pglite) PostgreSQL database and
Server-Sent Events (SSE). No external database service required.

## Architecture

- **Backend** — Node.js + Express. Embedded PGLite persists data to
  `./data/pgdata`. New messages are broadcast to all connected clients over
  an SSE stream.
- **Frontend** — Vanilla JS bundled with Vite. Renders the message feed,
  loads history on load, and subscribes to live updates via `EventSource`.

### API

| Method | Path            | Description                              |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/api/messages` | Fetch message history (initial state).   |
| POST   | `/api/messages` | Create a message `{ "text": "..." }`.    |
| GET    | `/api/stream`   | SSE stream of new messages.              |

## Getting started

```bash
npm install

# Run backend (:3000) and frontend dev server (:5173) together.
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3000.

### Production

```bash
npm run build   # outputs to ./dist
npm start       # Express serves the built frontend + API on :3000
```

Then open http://localhost:3000.

## Data persistence

PGLite writes to `./data/pgdata`. Override the location with the
`PGLITE_DATA_DIR` environment variable.
