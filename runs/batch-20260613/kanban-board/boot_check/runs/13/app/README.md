# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded **PGLite** database,
an **Express** backend, **Server-Sent Events (SSE)** for live sync, and a
lightweight **Vanilla JS + Vite** frontend with drag-and-drop.

## Architecture

- **Backend** (`server/`)
  - `db.js` — embedded PGLite persisted to `data/pgdata`, schema + seed data.
  - `board.js` — board reads + fractional-position ordering logic (server-authoritative).
  - `sse.js` — SSE connection registry + broadcaster.
  - `index.js` — Express app: REST mutations, `GET /api/board`, `GET /api/stream`.
- **Frontend** (`index.html`, `src/`)
  - Renders columns/cards from `GET /api/board`.
  - Native HTML5 drag-and-drop with optimistic repositioning.
  - `EventSource` subscription reconciles every client to canonical state.

## Ordering & concurrency

- Each card has a fractional `position`. Moves insert at the midpoint between
  neighbors — no full re-index needed.
- Moves run inside a single transaction (remove + add), so a card is never
  observed in two columns.
- Collisions / precision exhaustion trigger a column **renormalization**, and the
  corrected order is broadcast to all clients.
- The server returns the full canonical ordering of affected columns; clients
  replace their optimistic guess with this authoritative state.

## API

- `GET  /api/board` — `{ columns: [{ id, title, position, cards: [...] }] }`
- `POST /api/cards` — `{ columnId, text }` → creates at end of column.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` → canonical move.
- `GET  /api/stream` — SSE: `card.created`, `card.moved` events.

## Running

```bash
npm install

# Development (Vite dev server on :5173 proxying API to backend on :3000)
npm run dev

# Production (build the SPA, then serve everything from the Node server on :3000)
npm run build
npm start
```

Open the app, then open it in a second tab/browser to see live convergence.
