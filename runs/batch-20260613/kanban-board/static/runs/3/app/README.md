# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + Vite

## Quick Start

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
| `server/db.js` | PGLite init, schema creation, seeding |
| `server/sse.js` | SSE client registry + broadcast |
| `server/ordering.js` | Fractional position helpers |
| `server/routes/board.js` | `GET /api/board` |
| `server/routes/cards.js` | `POST /api/cards`, `PATCH /api/cards/:id/move` |
| `server/routes/stream.js` | `GET /api/stream` (SSE) |

### Frontend

| File | Purpose |
|------|---------|
| `client/index.html` | App shell |
| `client/style.css` | All styles |
| `client/main.js` | State, render, drag-and-drop, SSE, modal |

### Key Design Decisions

1. **Fractional positions** – each card has a `DOUBLE PRECISION position`. Inserting between two cards uses the midpoint. Renormalisation is triggered when the gap falls below 1e-9.

2. **Server-authoritative ordering** – clients send intent (`beforeId`/`afterId`); the server computes the canonical position and broadcasts it. Clients reconcile their optimistic guess against the SSE event.

3. **Atomic moves** – `PATCH /api/cards/:id/move` updates `column_id` and `position` in a single SQL statement. No client ever observes a card in two columns.

4. **SSE events**
   - `card:created` – new card payload
   - `card:moved` – canonical card after a move
   - `column:reordered` – full ordered card list for a column after renormalisation

## API

### `GET /api/board`
Returns `{ columns: [{ id, title, position, cards: [{ id, column_id, text, position, created_at }] }] }`.

### `POST /api/cards`
Body: `{ columnId, text }`. Creates a card at the end of the column.

### `PATCH /api/cards/:id/move`
Body: `{ columnId, beforeId?, afterId? }`. Moves a card; server computes canonical position.

### `GET /api/stream`
SSE stream. Events: `card:created`, `card:moved`, `column:reordered`.
