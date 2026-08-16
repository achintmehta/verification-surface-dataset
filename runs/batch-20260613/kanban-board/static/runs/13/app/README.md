# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
([PGLite](https://github.com/electric-sql/pglite)) backend and a vanilla
JS + Vite frontend. Updates propagate to all connected clients via
Server-Sent Events (SSE).

## Architecture

```
client/            Vanilla JS SPA (Vite)
  index.html
  style.css
  main.js          Rendering, drag & drop, optimistic updates, SSE
  store.js         In-memory board model (cards keyed by id => never duplicated)
  api.js           REST client
server/            Node.js + Express backend
  index.js         HTTP routes + SSE endpoint
  db.js            PGLite init, schema, default columns
  board.js         Ordering logic (fractional positions, renormalization)
  sse.js           SSE connection hub + broadcast
data/              PGLite on-disk database (created at runtime)
```

## How ordering works

Each card has a numeric `position` within its column. Inserting between two
cards uses the midpoint of their positions, so moves are O(1) and never
re-index the whole column. The server is **authoritative**: clients send the
intent (`{ columnId, beforeId, afterId }`) and the server computes the canonical
position inside a single transaction, then broadcasts the committed result.

If a gap is exhausted (positions collide or floating-point precision runs out),
the server **renormalizes** the affected column to evenly spaced integers and
broadcasts the corrected order so every client snaps to the same ordering.

Because the client store keys cards by `id`, applying a move can only ever place
a card in one column — duplication across columns is structurally impossible.

## API

- `GET  /api/board` — all columns, each with cards ordered by position.
- `POST /api/cards` — `{ columnId, text }` → creates a card at the column end.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` → moves/reorders.
- `GET  /api/stream` — SSE stream of `card:create` and `card:move` events.

## Running

```bash
npm install
npm run dev      # runs the API server (3001) and Vite dev server (5173)
```

Open http://localhost:5173 in two browser windows to see real-time sync.

To run just the backend (serves the API on port 3001):

```bash
npm run start
```

### Production build

```bash
npm run build    # outputs static SPA to dist/
```
