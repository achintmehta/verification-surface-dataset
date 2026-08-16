# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
(PGLite) backend, Server-Sent Events for live sync, and a Vanilla JS + Vite
frontend with drag-and-drop.

## Architecture

- **Backend** (`server/`): Express + PGLite (persisted to `server/.pgdata`).
  - `db.js` — PGLite init, schema, default-column seeding.
  - `ordering.js` — fractional position computation + renormalization rules.
  - `board.js` — board read, card create, atomic transactional card move.
  - `sse.js` — SSE connection registry + broadcast.
  - `index.js` — Express app, routes, SSE endpoint.
- **Frontend** (`client/`): Vanilla JS rendered from board state, with
  optimistic drag-and-drop reconciled against canonical SSE events.

## Data model

- `columns(id, title, position)`
- `cards(id, column_id, text, position, created_at)`

Cards order within a column by a `DOUBLE PRECISION` fractional `position`.
Moves insert between neighbours' positions; tight gaps trigger an atomic
column renormalization that is broadcast as `column:reordered`.

## API

- `GET  /api/board` — full board: ordered columns each with ordered cards.
- `POST /api/cards` — `{ columnId, text }` → creates card at end of column.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` → atomic move.
- `GET  /api/stream` — SSE stream of `card:created`, `card:moved`,
  `column:reordered`.

## Real-time convergence

- The server is authoritative for ordering. Clients send intent; the server
  computes the canonical position inside a transaction and broadcasts the
  committed card. Cards are keyed by id in client state, so adopting the
  canonical card guarantees it renders in exactly one column.

## Running

```bash
npm install
npm run dev        # runs backend (:3000) + Vite frontend (:5173) together
```

Then open http://localhost:5173 in two browser windows to see live sync.

For a production-style run:

```bash
npm run build
npm start          # serves API on :3000
```
