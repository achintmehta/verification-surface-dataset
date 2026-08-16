# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Features

- Shared board with three default columns: *To Do*, *In Progress*, *Done*
- Create cards in any column
- Drag-and-drop cards within and across columns
- All connected clients converge in real time via SSE
- Optimistic UI with server-authoritative reconciliation
- Fractional position ordering with automatic renormalisation

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
    main.js      Bootstrap, SSE wiring, action handlers
    api.js       HTTP client (fetch wrappers)
    state.js     In-memory board state + optimistic mutations
    board.js     DOM rendering + fine-grained update helpers
    drag.js      HTML5 drag-and-drop logic
    sse.js       EventSource connection + event dispatch
    style.css    All styles

server/          Node.js + Express
  index.js       Server entry point
  db.js          PGLite initialisation + schema bootstrap
  sse.js         SSE client registry + broadcast helpers
  ordering.js    Fractional position helpers + renormalisation
  routes/
    board.js     GET  /api/board
    cards.js     POST /api/cards, PATCH /api/cards/:id/move
    stream.js    GET  /api/stream (SSE)
```

## API

| Method | Path                    | Description                        |
|--------|-------------------------|------------------------------------|
| GET    | `/api/board`            | Full board state                   |
| POST   | `/api/cards`            | Create a card                      |
| PATCH  | `/api/cards/:id/move`   | Move / reorder a card              |
| GET    | `/api/stream`           | SSE event stream                   |
| GET    | `/api/health`           | Health check                       |

## SSE Events

| Event          | Payload                                      |
|----------------|----------------------------------------------|
| `card:created` | `{ card }`                                   |
| `card:moved`   | `{ card }`                                   |
| `board:reorder`| `{ columns: [{ columnId, cards }] }`         |
