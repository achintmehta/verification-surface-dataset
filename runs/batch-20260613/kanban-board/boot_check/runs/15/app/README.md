# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PostgreSQL
(PGLite) backend, Server-Sent Events for live sync, and a Vanilla JS + Vite
frontend with drag-and-drop.

## Architecture

- **Backend** (`server/`): Node.js + Express.
  - `db.js` — embedded PGLite (persists to `./pgdata`), schema + seed.
  - `ordering.js` — fractional-position ordering, atomic moves, renormalization.
  - `sse.js` — SSE connection registry + broadcast.
  - `index.js` — HTTP API and SSE endpoint.
- **Frontend** (`client/`): Vanilla JS SPA bundled by Vite.
  - Optimistic drag-and-drop reconciled against server-authoritative ordering.

## Data model

- `columns(id, title, position)`
- `cards(id, column_id, text, position, created_at)`

Cards use **fractional `position`** values within a column. Inserting between
two cards uses the midpoint of their positions, avoiding full re-indexing.
Ordering is rendered by `position ASC, id ASC` for a total, stable order.

## Concurrency & convergence

- The server is authoritative on ordering. Clients send intent
  (`{ columnId, beforeId, afterId }`); the server computes the canonical
  position inside a **single transaction** (remove + place are atomic, so a
  card never lives in two columns) and broadcasts the committed card.
- On midpoint collision / precision exhaustion the server **renormalizes** the
  affected column and broadcasts the corrected order (`column:renormalize`).
- Clients apply an optimistic move, then snap to the server's canonical
  position on the broadcast.

## API

- `GET  /api/board` — full board (columns with ordered cards).
- `POST /api/cards` — `{ columnId, text }` → create at end of column.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` → move.
- `GET  /api/stream` — SSE stream of `card:create`, `card:move`,
  `column:renormalize` events.

## Running

```bash
npm install

# Run backend + frontend dev servers together:
npm run dev
# Backend:  http://localhost:3000
# Frontend: http://localhost:5173 (proxies /api to the backend)

# Or build the frontend and serve everything from the backend:
npm run build
npm start            # http://localhost:3000
```
