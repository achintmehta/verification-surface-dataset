# Realtime Board

A lightweight, local-first collaborative message board demonstrating an embedded
**PGLite** PostgreSQL database combined with **Server-Sent Events (SSE)** for
real-time updates. The frontend is a tiny Vanilla JS app built with **Vite**.

## Architecture

```
┌────────────┐   POST /api/messages    ┌─────────────────────┐
│            │ ──────────────────────► │                     │
│  Browser   │                         │   Express server    │
│ (Vanilla   │ ◄────── SSE ─────────── │   + PGLite (WASM)   │
│   JS)      │   GET /api/stream       │   persisted to disk │
│            │                         │                     │
│            │ ──── GET /api/messages ►│                     │
└────────────┘                         └─────────────────────┘
```

- **Backend** (`server/`): Express + `@electric-sql/pglite`. Messages are stored
  in a `messages` table and persisted to `./data/board`. New posts are broadcast
  to every connected client over SSE.
- **Frontend** (`client/`): A single HTML page + `main.js` that loads history,
  subscribes to the SSE stream, and posts new messages.

## Endpoints

| Method | Path            | Description                              |
| ------ | --------------- | ---------------------------------------- |
| GET    | `/api/messages` | Fetch all messages (initial state)       |
| POST   | `/api/messages` | Create a message `{ "text": "..." }`     |
| GET    | `/api/stream`   | SSE stream of new messages               |
| GET    | `/api/health`   | Health check + active client count       |

## Getting started

```bash
npm install

# Run backend + frontend dev servers together
npm run dev
```

- Frontend dev server: http://localhost:5173 (proxies `/api` to the backend)
- Backend server: http://localhost:3001

### Production

```bash
npm run build   # builds the frontend into ./dist
npm start       # serves the API and the built frontend from :3001
```

## Notes

- Data is persisted to `./data/board` (override with `PGLITE_DATA_DIR`).
- No authentication — this is a demo of the PGLite + SSE pattern.
