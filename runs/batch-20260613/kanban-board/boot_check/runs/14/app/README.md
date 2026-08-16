# Collaborative Kanban Board

Real-time multi-user Kanban board built with an embedded PGLite database,
Server-Sent Events for live convergence, and a Vanilla JS + Vite frontend.

## Features

- Ordered columns each with an ordered list of cards.
- Create cards, move cards across columns, reorder within a column (drag & drop).
- Fractional `position` ordering — moves are cheap, no full re-index.
- Server-authoritative ordering; clients reconcile optimistic updates against
  the canonical broadcast.
- Durable persistence to local disk via PGLite (`.pgdata/`).
- Real-time sync to all connected clients via SSE.
- Automatic renormalization on position collision / precision exhaustion.

## Getting Started

```bash
npm install

# Run backend (port 3001) and frontend dev server (port 5173) together:
npm run dev
```

Then open http://localhost:5173. The Vite dev server proxies `/api/*` to the
backend on port 3001.

### Production-style run

```bash
npm run build   # builds the frontend into ./dist
npm start       # serves the API + built frontend on port 3001
```

## Architecture

- `server/index.js` — Express app: `/api/board`, `/api/cards`,
  `/api/cards/:id/move`, `/api/stream` (SSE).
- `server/db.js` — PGLite init + schema (`columns`, `cards`) + default seed.
- `server/board.js` — board queries and atomic move/ordering logic.
- `server/sse.js` — SSE connection registry + broadcaster.
- `client/` — Vanilla JS SPA with drag-and-drop and EventSource sync.

## Endpoints

| Method | Path                   | Description                              |
| ------ | ---------------------- | ---------------------------------------- |
| GET    | `/api/board`           | Full board: columns with ordered cards   |
| POST   | `/api/cards`           | Create a card `{ columnId, text }`       |
| PATCH  | `/api/cards/:id/move`  | Move `{ columnId, beforeId, afterId }`   |
| GET    | `/api/stream`          | SSE stream of `card:create`/`card:move`  |
