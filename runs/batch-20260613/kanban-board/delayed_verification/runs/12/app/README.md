# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PostgreSQL
(PGLite) backend, Server-Sent Events for live sync, and a Vanilla JS + Vite
frontend with drag-and-drop.

## Architecture

- **Backend** (`server/`): Express server using `@electric-sql/pglite`
  persisted to local disk (`data/pgdata`). Mutations are plain HTTP requests;
  updates are pushed to clients via SSE.
- **Frontend** (`client/`): A lightweight SPA. Drag-and-drop applies an
  optimistic local update, then reconciles against the server's authoritative
  ordering.

### Ordering model

Every card has a fractional `position` within its column. Inserting between
two cards uses a value halfway between their positions, avoiding full
re-indexing. The server is authoritative: clients send intent
(`{ columnId, beforeId, afterId }`) and the server computes the canonical
position in a single transaction. If fractional precision is exhausted (or a
collision occurs), the server renormalizes the column to evenly spaced
integers and broadcasts the corrected order.

### Convergence guarantees

- A move runs in one transaction (remove from source + place in target) so a
  card is never observable in two columns.
- The server broadcasts only committed canonical state.
- Clients upsert canonical cards, removing every existing copy first, so a
  card always renders in exactly one place.

## Getting started

```bash
npm install
npm run dev      # runs backend (3001) + Vite dev server (5173)
```

Open http://localhost:5173 in two browser windows to see real-time sync.

### Production-ish

```bash
npm run build    # builds the SPA to dist/
npm start        # runs the backend (serve dist/ behind any static host)
```

## API

- `GET  /api/board` — full board: ordered columns, each with ordered cards.
- `POST /api/cards` — `{ columnId, text }` create a card at column end.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` move/reorder.
- `GET  /api/stream` — SSE stream of `card:created`, `card:moved`,
  `column:normalized` events.
