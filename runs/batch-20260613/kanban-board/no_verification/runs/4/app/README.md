# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)
- **Drag-and-drop**: Native HTML5 Drag-and-Drop API

## Features

- Shared board with three default columns: **To Do**, **In Progress**, **Done**
- Create cards in any column
- Drag cards within a column to reorder them
- Drag cards across columns
- All connected clients see changes in real time via SSE
- Optimistic UI: the dragging client updates immediately, then reconciles against the server's authoritative ordering
- Fractional position ordering with automatic renormalisation to prevent precision exhaustion
- Board state persisted to local disk via PGLite

## Getting Started

```bash
# Install dependencies
npm install

# Start both backend (port 3001) and frontend dev server (port 5173)
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in one or more browser tabs.

## Architecture

```
client/                  # Vite SPA (Vanilla JS)
  src/
    main.js              # Boot: fetch board, connect SSE
    api.js               # HTTP client (fetch wrappers)
    store.js             # Client-side board state
    render.js            # DOM reconciliation
    dragdrop.js          # HTML5 drag-and-drop
    sse-client.js        # EventSource + event handlers
    style.css            # Styles

server/                  # Node.js backend
  index.js               # Express app entry point
  db.js                  # PGLite database layer
  sse.js                 # SSE connection registry + broadcast
  routes/
    board.js             # GET /api/board, POST /api/cards, PATCH /api/cards/:id/move, GET /api/stream

data/pglite/             # PGLite data directory (auto-created, gitignored)
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/board` | Full board state (columns + cards) |
| `GET` | `/api/stream` | SSE stream |
| `POST` | `/api/cards` | Create a card `{ columnId, text }` |
| `PATCH` | `/api/cards/:id/move` | Move a card `{ columnId, beforeId?, afterId? }` |

## SSE Events

| Event | Payload | Description |
|-------|---------|-------------|
| `card:created` | `{ card }` | A new card was created |
| `card:moved` | `{ card }` | A card was moved/reordered |
| `column:reordered` | `{ columnId, cards }` | Column positions were renormalised |
