# Realtime Message Board

A lightweight, local-first message board built with an embedded **PGLite**
database and **Server-Sent Events (SSE)** for real-time updates. The frontend
is a Vanilla JS Single Page Application served by **Vite**.

## Architecture

- **Backend** (`server/`): Node.js + Express
  - `db.js` — initializes an embedded PGLite database persisted to `./pgdata`,
    creating the `messages` table (`id`, `text`, `created_at`).
  - `sse.js` — tracks active SSE connections and broadcasts events.
  - `index.js` — REST + SSE endpoints.
- **Frontend** (`index.html`, `src/`): Vanilla JS + Vite.

## API

| Method | Path            | Description                                   |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/api/messages` | Fetch all historical messages (initial state) |
| POST   | `/api/messages` | Post a new message `{ "text": "..." }`        |
| GET    | `/api/stream`   | SSE stream of new messages (`message` events)  |

## Getting Started

Install dependencies:

```bash
npm install
```

Run both the backend and the Vite dev server together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (proxies `/api` to the backend)
- Backend:  http://localhost:3001

You can also run them separately:

```bash
npm run server   # Express + PGLite on :3001
npm run client   # Vite dev server on :5173
```

## How real-time works

1. On load, the client fetches `GET /api/messages` to render history.
2. The client opens an `EventSource` to `GET /api/stream`.
3. Posting via `POST /api/messages` inserts into PGLite and broadcasts the new
   message to every connected SSE client, which append it to the DOM.

## Notes

- Data persists to the `pgdata/` directory on disk (configurable via the
  `PGLITE_DIR` env var).
- The backend port is configurable via the `PORT` env var (default `3001`).
