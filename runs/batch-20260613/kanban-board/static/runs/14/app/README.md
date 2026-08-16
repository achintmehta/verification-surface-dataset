# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PostgreSQL
(PGLite) backend and Server-Sent Events (SSE) for live convergence. The
frontend is a lightweight Vanilla JS SPA (Vite) with drag-and-drop.

## Architecture

- **Backend** (`server/`): Node.js + Express.
  - `db.js` — embedded PGLite persisted to `server/.data/kanban`, schema
    (`columns`, `cards`) and default seed columns.
  - `board.js` — board state queries + the fractional-position ordering and
    atomic move logic, including renormalization when positions collide or
    exhaust numeric precision.
  - `sse.js` — SSE connection hub and broadcast.
  - `index.js` — HTTP routes + SSE endpoint + error handling.
- **Frontend** (`client/`): Vanilla JS SPA.
  - Renders columns/cards from `GET /api/board`.
  - Drag-and-drop optimistically repositions the card, then sends intent.
  - Subscribes to `GET /api/stream` and reconciles to canonical state.

## Key design points

- **Fractional positions**: a moved card's position is computed between its
  neighbors `(after + before) / 2`, avoiding full re-indexing.
- **Server-authoritative ordering**: clients send intent
  (`{ columnId, beforeId, afterId }`); the server computes and persists the
  canonical position atomically and broadcasts it.
- **Atomic moves**: column reassignment + position update happen in a single
  transaction, so a card is never observed in two columns.
- **Renormalization**: when a slot becomes too tight to represent distinctly,
  the column is re-spaced with even gaps and the corrected order is broadcast
  via a `column:reordered` event.
- **Total, stable ordering**: cards sort by `(position, created_at, id)` on
  both server and client.

## API

- `GET  /api/board` — full board (columns, each with ordered cards).
- `POST /api/cards` — `{ columnId, text }`; appends a card; broadcasts
  `card:created`.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }`; moves the
  card; broadcasts `card:moved` (and `column:reordered` if renormalized).
- `GET  /api/stream` — SSE stream of `card:created`, `card:moved`,
  `column:reordered` events.

## Running

```bash
npm install
npm run dev      # runs backend (:3000) and Vite frontend (:5173) together
```

Open http://localhost:5173 in two browser windows to see real-time sync.

For production:

```bash
npm run build    # builds the client into dist/
npm start        # runs the backend (serve dist/ behind your static host)
```
