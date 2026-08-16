# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + Vite, drag-and-drop, optimistic updates

## Features

- Shared board with ordered columns and cards
- Create cards in any column
- Drag-and-drop cards within and across columns
- All connected clients converge in real time via SSE
- Optimistic UI: the dragging client updates immediately, then reconciles against the server's authoritative ordering
- Fractional position ordering with automatic renormalisation on precision exhaustion
- Durable persistence via PGLite writing to local disk

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001/api

## Architecture

### Backend

| File | Purpose |
|------|---------|
| `server/index.js` | Express app bootstrap |
| `server/db.js` | PGLite initialisation, schema, seeding |
| `server/sse.js` | SSE client registry and broadcast |
| `server/ordering.js` | Fractional position computation and renormalisation |
| `server/routes/board.js` | `GET /api/board` |
| `server/routes/cards.js` | `POST /api/cards`, `PATCH /api/cards/:id/move` |
| `server/routes/stream.js` | `GET /api/stream` (SSE) |

### Frontend

| File | Purpose |
|------|---------|
| `client/index.html` | App shell |
| `client/style.css` | All styles |
| `client/main.js` | State, rendering, drag-and-drop, SSE, API calls |

### API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/board` | Full board state (columns + cards) |
| `POST` | `/api/cards` | Create a card `{ columnId, text }` |
| `PATCH` | `/api/cards/:id/move` | Move a card `{ columnId, afterId?, beforeId? }` |
| `GET` | `/api/stream` | SSE stream |

### SSE Events

| Event | Payload | Description |
|-------|---------|-------------|
| `card-created` | `{ card }` | A new card was created |
| `card-moved` | `{ card }` | A card was moved/reordered |
| `column-reorder` | `{ columnId, cards }` | Column positions were renormalised |

## Ordering Strategy

Cards carry a `DOUBLE PRECISION position` value. Inserting between two cards uses the midpoint of their positions. When the gap falls below `1e-9`, the server renormalises the entire column (evenly spacing all cards by 1000) and broadcasts the corrected order so every client converges.
