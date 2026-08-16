# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view one shared board,
create cards, and move/reorder them via drag-and-drop. All clients converge on
the same state in real time.

- **Backend:** Node.js + Express, embedded [PGLite](https://github.com/electric-sql/pglite)
  persisting to local disk, Server-Sent Events (SSE) for push.
- **Frontend:** Vanilla JS + Vite single-page app with native HTML5 drag-and-drop.

## Architecture

- **Fractional positions.** Each card has a `DOUBLE PRECISION` `position` within
  its column. Inserting between two cards uses the midpoint of their positions,
  so moves never re-index a whole column.
- **Server is authoritative.** Clients send intent (`{ columnId, afterId, beforeId }`).
  The server computes the canonical `position`, commits it in a transaction, and
  broadcasts the canonical card. Clients reconcile their optimistic guess.
- **Atomic moves.** `column_id` and `position` are updated together in one
  transaction; only committed state is broadcast, so a card is never observed in
  two columns.
- **Renormalization.** If the gap between neighbors becomes too small or
  positions collide, the server reassigns evenly-spaced positions to the whole
  column and broadcasts the corrected order (`column:reordered`).

## API

- `GET  /api/board` — full board: ordered columns, each with ordered cards.
- `POST /api/cards` — `{ columnId, text }`; appends a card, broadcasts `card:created`.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }`; moves/reorders,
  broadcasts `card:moved` (and `column:reordered` if renormalized).
- `GET  /api/stream` — SSE stream of `card:created`, `card:moved`, `column:reordered`.

## Running

```bash
npm install
npm run dev      # runs backend (3001) and Vite dev server (5173) together
```

Open http://localhost:5173 in two browser windows to see real-time sync.

Production build:

```bash
npm run build    # builds the SPA to dist/
npm start        # runs the backend (serve dist/ with any static host)
```

Board state persists to `.pgdata/` on disk.
