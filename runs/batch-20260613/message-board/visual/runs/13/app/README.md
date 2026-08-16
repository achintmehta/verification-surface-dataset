# Realtime Board

A local-first collaborative message board demonstrating **embedded PGLite**
(PostgreSQL compiled to WASM, persisted to disk) combined with
**Server-Sent Events (SSE)** for instant real-time updates — no external
database service required.

## Architecture

```
Browser (Vanilla JS + Vite)
   │  GET  /api/messages   ← initial history
   │  GET  /api/stream     ← SSE live updates (EventSource)
   │  POST /api/messages   → post a new message
   ▼
Node.js + Express
   ├─ embedded PGLite (data/pgdata on local disk)
   └─ SSE connection registry (broadcasts new rows to every client)
```

- **Backend** (`server/`): Express server with CORS + JSON parsing, an embedded
  PGLite database persisting to `data/pgdata`, and an SSE endpoint that pushes
  new messages to all connected clients.
- **Frontend** (`index.html`, `src/`): a lightweight Vanilla JS SPA built with
  Vite. It loads history on startup, subscribes to the SSE stream, and posts
  new messages via `fetch`.

## Getting started

Install dependencies (provisioned from `package.json`):

```bash
npm install
```

### Development

Runs the backend (port `3001`) and the Vite dev server (port `5173`)
concurrently. Vite proxies `/api/*` to the backend.

```bash
npm run dev
```

Open http://localhost:5173

### Production-style run

Build the frontend and let the Node server serve it (everything on port `3001`):

```bash
npm run build
npm start
```

Open http://localhost:3001

## API

| Method | Path            | Description                                  |
| ------ | --------------- | -------------------------------------------- |
| GET    | `/api/messages` | Fetch all messages (chronological)           |
| POST   | `/api/messages` | Create a message `{ "text": "..." }`         |
| GET    | `/api/stream`   | SSE stream emitting `message` events         |
| GET    | `/api/health`   | Status + connected client count              |

## Database schema

```sql
CREATE TABLE messages (
  id          SERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Data is stored in `data/pgdata` and survives restarts. Override the location
with the `PGLITE_DATA_DIR` environment variable.
