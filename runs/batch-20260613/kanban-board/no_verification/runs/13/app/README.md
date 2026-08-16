# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PostgreSQL
(PGLite) backend and Server-Sent Events (SSE) for live convergence. The
frontend is a lightweight Vanilla JS SPA (Vite) with drag-and-drop.

## Architecture

- **Backend** (`server/`): Node.js + Express.
  - `@electric-sql/pglite` persists board state to `data/pgdata` on disk.
  - `columns` (`id`, `title`, `position`) and `cards`
    (`id`, `column_id`, `text`, `position`, `created_at`).
  - **Fractional position ordering**: a card's `position` is a `DOUBLE
    PRECISION`. Inserting between two cards uses the midpoint of their
    positions, so moves are O(1) and stable under concurrency.
  - **Server-authoritative ordering**: clients send intent
    (`{ columnId, afterId, beforeId }`); the server computes the canonical
    position inside a transaction and broadcasts the committed result.
  - **Collision / precision handling**: if the gap between neighbours is
    exhausted, the column is renormalized to evenly-spaced integer
    positions and the corrected order is broadcast.
  - **Atomic cross-column moves**: removing from the source and adding to
    the target happen in a single transaction, so a card is never visible
    in two columns.
- **Frontend** (`client/`): renders the board, drag-and-drop with optimistic
  updates, and an `EventSource` SSE subscription that reconciles every
  client to the server's canonical state.

## API

- `GET  /api/board` – full board (columns, each with ordered cards).
- `POST /api/cards` – `{ columnId, text }` create a card at column end.
- `PATCH /api/cards/:id/move` – `{ columnId, afterId, beforeId }` move/reorder.
- `GET  /api/stream` – SSE stream of `card-created` and `card-moved` events.

## Running

```bash
npm install
npm run dev      # runs backend (3001) and Vite frontend (5173) together
```

Then open http://localhost:5173 in two browser windows to see real-time
convergence.

To run only the backend: `npm run server`.
To build the frontend: `npm run build` (output in `dist/`).
