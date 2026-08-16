# Collaborative Kanban Board

A real-time, multi-user Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. All connected clients converge on the same board state in
real time.

## Stack

- **Backend:** Node.js + Express, embedded [PGLite](https://github.com/electric-sql/pglite)
  for durable on-disk PostgreSQL storage.
- **Real-time:** Server-Sent Events (SSE) push every mutation to all clients.
- **Frontend:** Vanilla JS SPA built with Vite, native HTML drag-and-drop.

## How it works

### Fractional position ordering
Each card has a numeric `position` within its column. Inserting between two
cards uses a value halfway between their positions, so moves are cheap and
ordering stays stable under concurrent edits. If two positions collide or
fractional precision is exhausted, the server **renormalizes** the column to
evenly spaced integers and broadcasts the corrected order.

### Server-authoritative ordering
Clients send *intent* — "move card X into column C between A and B". The server
computes the canonical `position`, performs the column reassignment and
position update **atomically in a single transaction**, and broadcasts the
canonical card. A move never leaves a card in two columns because clients
remove the card from everywhere before re-inserting it at its canonical slot.

### Optimistic UI
The dragging client repositions the card immediately, then sends the PATCH and
reconciles against the SSE broadcast, snapping to the server's order if it
differs from the optimistic guess.

## Endpoints

| Method | Path                  | Purpose                                  |
| ------ | --------------------- | ---------------------------------------- |
| GET    | `/api/board`          | Full board: columns each with cards      |
| POST   | `/api/cards`          | Create a card at the end of a column     |
| PATCH  | `/api/cards/:id/move` | Move/reorder a card (`{columnId,beforeId,afterId}`) |
| GET    | `/api/stream`         | SSE stream of `card:create`, `card:move`, `column:reorder` |

## Running

```bash
npm install
npm run dev      # backend (3001) + Vite dev server (5173) together
```

Open http://localhost:5173 in two browser windows to see live convergence.

For a production-style single-origin run:

```bash
npm install
npm run build    # builds the frontend to /dist
npm start        # serves API + built frontend on http://localhost:3001
```

Board state persists under `.data/kanban`.
