# Realtime Message Board

A local-first, realtime message board built with an **embedded PGLite** database
(PostgreSQL compiled to WASM, running inside Node.js) and **Server-Sent Events (SSE)**
for instant updates. The frontend is a lightweight Vanilla JS app powered by Vite.

## Architecture

```
Browser (Vanilla JS + Vite)
  │  GET  /api/messages   -> initial history
  │  GET  /api/stream     -> SSE live updates (EventSource)
  │  POST /api/messages   -> create message
  ▼
Node.js + Express
  │  embedded PGLite (persisted to ./data/pgdata)
  ▼
Local filesystem
```

- **Decision 1** — Embedded PGLite avoids running a separate Postgres service; data
  persists to `./data/pgdata` on disk.
- **Decision 2** — SSE provides one-way server→client realtime push over plain HTTP
  (clients post via standard `POST`), avoiding a WebSocket library.
- **Decision 3** — Vanilla JS + Vite keeps the build fast and the dependency tree small.

## Getting Started

```bash
npm install
npm run dev
```

- Backend: http://localhost:3001
- Frontend (Vite dev server): http://localhost:5173

The dev script runs the backend and frontend concurrently.

### Production

```bash
npm run build   # builds the frontend into ./dist
npm start       # Express serves the API + the built frontend on :3001
```

## API

| Method | Path            | Description                              |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/api/messages` | Fetch all messages (chronological order) |
| POST   | `/api/messages` | Create a message `{ "text": "hi" }`      |
| GET    | `/api/stream`   | SSE stream of new messages (`message` event) |

## Database Schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
