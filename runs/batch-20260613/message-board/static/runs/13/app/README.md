# Realtime Board

A lightweight, local-first real-time message board built with an embedded
**PGLite** database and **Server-Sent Events (SSE)**. No external database
service is required — PostgreSQL runs directly inside the Node.js process and
persists to the local disk.

## Architecture

- **Backend** (`server/`): An Express server.
  - `db.js` — boots embedded PGLite (persisted to `./pgdata`) and creates the
    `messages` table (`id`, `text`, `created_at`).
  - `sse.js` — maintains the registry of active SSE connections and broadcasts.
  - `index.js` — REST + SSE endpoints.
- **Frontend** (`client/`): A Vanilla JS + Vite single-page app.

## API

| Method | Path             | Description                                          |
| ------ | ---------------- | ---------------------------------------------------- |
| GET    | `/api/messages`  | Fetch full message history (oldest first).           |
| POST   | `/api/messages`  | Insert a new message `{ "text": "..." }`.            |
| GET    | `/api/stream`    | SSE stream; emits a `message` event per new message. |

## Getting started

```bash
npm install
npm run dev
```

- Frontend dev server: http://localhost:5173 (proxies `/api` to the backend)
- Backend server: http://localhost:3001

### Production

```bash
npm run build   # build the frontend into dist/
npm start       # run the backend
```
