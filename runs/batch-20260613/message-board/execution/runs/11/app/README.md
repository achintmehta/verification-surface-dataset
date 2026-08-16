# Realtime Message Board

A local-first, real-time message board built with an embedded
[PGLite](https://github.com/electric-sql/pglite) database and
[Server-Sent Events (SSE)](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events).
No external database service required — everything runs inside a single Node.js
process and persists to the local disk.

## Architecture

```
client (Vite + Vanilla JS)  ──HTTP POST──▶  server (Express)
        ▲                                        │
        │                                        ▼
        └────────── SSE stream ──────────  PGLite (embedded Postgres → ./server/data)
```

- **Backend** (`server/`): Express server using embedded PGLite for raw SQL,
  exposing REST + an SSE stream.
- **Frontend** (`client/`): Lightweight Vanilla JS SPA built with Vite.

## Getting started

Install all dependencies (root, server, and client):

```bash
npm run install:all
```

Run both the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite dev server, proxies `/api` → backend)
- Backend: http://localhost:3001

## API

| Method | Path             | Description                                    |
| ------ | ---------------- | ---------------------------------------------- |
| GET    | `/api/messages`  | Fetch all historical messages (initial state). |
| POST   | `/api/messages`  | Post a new message `{ "text": "..." }`.        |
| GET    | `/api/stream`    | SSE stream emitting `message` events live.     |
| GET    | `/api/health`    | Health check.                                  |

## Data persistence

PGLite writes to `server/data/pgdata` by default. Override with the
`PGLITE_DATA_DIR` environment variable. The `messages` table is created
automatically on startup:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id         SERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## Production build

```bash
npm run build      # builds the client into client/dist
npm start          # starts the backend (serve client/dist behind your proxy)
```
