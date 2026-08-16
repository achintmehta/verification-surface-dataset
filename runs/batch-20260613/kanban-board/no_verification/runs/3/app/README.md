# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL persisted to disk)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Features

- Shared board with three default columns: **To Do**, **In Progress**, **Done**
- Create cards in any column
- Drag-and-drop cards within and across columns
- All connected clients converge on the same board state in real time
- Optimistic UI: the dragging client updates immediately, then reconciles against the server's authoritative ordering
- Fractional position ordering with automatic renormalisation on precision exhaustion
- Board state persisted to disk via PGLite

## Getting Started

```bash
# Install dependencies
npm install

# Start both backend and frontend dev servers
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## Architecture

### Backend (`server/`)

| File | Purpose |
|------|---------|
| `index.js` | Express server entry point |
| `db.js` | PGLite instance + schema init + seed |
| `sse.js` | SSE client registry + broadcast |
| `ordering.js` | Fractional position helpers + renormalisation |
| `routes/board.js` | `GET /api/board` |
| `routes/cards.js` | `POST /api/cards`, `PATCH /api/cards/:id/move` |
| `routes/stream.js` | `GET /api/stream` (SSE) |

### Frontend (`client/src/`)

| File | Purpose |
|------|---------|
| `main.js` | App entry point, wires everything together |
| `api.js` | HTTP client for backend API |
| `state.js` | Client-side board state store |
| `board.js` | DOM renderer (incremental updates) |
| `dragdrop.js` | Mouse-based drag-and-drop engine |
| `stream.js` | SSE connection manager with auto-reconnect |

### Data Flow

```
User drags card
  → optimistic DOM update (state.js + board.js)
  → PATCH /api/cards/:id/move (api.js)
    → server computes canonical position (ordering.js)
    → atomic UPDATE in PGLite (db.js)
    → broadcast card:moved to all SSE clients (sse.js)
      → each client reconciles DOM to canonical state (main.js)
```

## API

### `GET /api/board`
Returns the full board state.

### `POST /api/cards`
Body: `{ columnId: string, text: string }`  
Creates a card at the end of the specified column.

### `PATCH /api/cards/:id/move`
Body: `{ columnId: string, beforeId?: string, afterId?: string }`  
Moves a card. `beforeId` is the card immediately before the target slot; `afterId` is the card immediately after. Either may be null/omitted.

### `GET /api/stream`
SSE endpoint. Events:
- `board:init` – full board state (sent on connect)
- `card:created` – `{ card }`
- `card:moved` – `{ card }`
- `column:reorder` – `{ columnId, cards }` (after position renormalisation)
