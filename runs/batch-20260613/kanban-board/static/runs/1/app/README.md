# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Features

- Shared board with ordered columns and cards
- Drag-and-drop to move and reorder cards within and across columns
- Optimistic UI updates reconciled against server-authoritative state
- Real-time convergence: all connected clients see the same board
- Fractional position ordering with automatic renormalisation
- Durable persistence via PGLite on local disk

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## Architecture

```
client/          Vanilla JS SPA (Vite)
  src/
    main.js      Boot sequence
    api.js       fetch() wrappers
    state.js     Client-side board state
    board.js     DOM rendering
    dragdrop.js  HTML5 drag-and-drop
    add-card.js  Add-card form
    sse-client.js EventSource connection

server/          Express + PGLite
  index.js       Entry point
  db.js          PGLite init + schema
  sse.js         SSE broker
  ordering.js    Fractional position helpers
  routes/
    board.js     GET /api/board
    cards.js     POST /api/cards, PATCH /api/cards/:id/move
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/board` | Full board state |
| `POST` | `/api/cards` | Create a card |
| `PATCH` | `/api/cards/:id/move` | Move / reorder a card |
| `GET` | `/api/stream` | SSE event stream |

### SSE Events

| Event | Payload |
|-------|---------|
| `card:created` | `{ card }` |
| `card:moved` | `{ card, sourceColumnId }` |
| `renorm` | `{ columnId, cards: [{ id, position }] }` |
