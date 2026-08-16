# Collaborative Kanban Board

A real-time, multi-user Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. Every mutation is broadcast to all connected clients over
Server-Sent Events (SSE) so boards stay convergent in real time.

- **Backend**: Node.js + Express, with embedded [PGLite](https://pglite.dev)
  (PostgreSQL compiled to WASM) persisting board state to local disk.
- **Realtime**: Server-Sent Events (server → clients), HTTP for mutations.
- **Frontend**: Vanilla JS Single Page Application built with Vite, native
  HTML5 drag-and-drop, optimistic updates reconciled against server state.

## Architecture

```
Browser (SPA)  ──HTTP POST/PATCH──▶  Express server  ──SQL──▶  PGLite (disk)
      ▲                                     │
      └──────────── SSE (EventSource) ◀─────┘  broadcast canonical state
```

### Ordering: fractional positions

Each card has a numeric `position` within its column. Inserting a card between
two others uses a value *between* their positions, so a move only updates a
single row instead of re-indexing the whole column. The **server is
authoritative**: clients send intent (`{ columnId, beforeId, afterId }`) and the
server computes the canonical position, persists it atomically, and broadcasts
the result.

### Concurrency & convergence

- **Atomic moves**: a move (remove from source + insert into target) runs inside
  a single transaction, and only committed state is broadcast, so a card can
  never appear in two columns.
- **Last-write-wins**: concurrent moves of the same card serialize on the
  single-connection PGLite instance; the card ends up in exactly one place and
  every client snaps to the broadcast canonical state.
- **Renormalization**: when fractional positions collide or precision is
  exhausted, the server reassigns evenly spaced positions for the affected
  column and broadcasts the corrected order; clients snap to it.

## Getting started

```bash
npm install

# Run backend (port 3001) and Vite frontend (port 5173) together:
npm run dev
# then open http://localhost:5173

# Or build the SPA and serve everything from the Node server (port 3001):
npm run build
npm start
# then open http://localhost:3001
```

Open the app in two browser windows to see real-time collaboration: creating,
moving, and reordering cards in one window updates the other instantly.

## API

| Method | Path                    | Description                                           |
| ------ | ----------------------- | ----------------------------------------------------- |
| GET    | `/api/board`            | Full board: columns each with cards ordered by position |
| POST   | `/api/cards`            | Create a card `{ columnId, text }` at the end of a column |
| PATCH  | `/api/cards/:id/move`   | Move/reorder `{ columnId, beforeId, afterId }`        |
| GET    | `/api/stream`           | SSE stream of `card-created` / `card-moved` events    |

## Data model

```sql
columns(id TEXT PK, title TEXT, position DOUBLE PRECISION)
cards(id TEXT PK, column_id TEXT FK, text TEXT,
      position DOUBLE PRECISION, created_at TIMESTAMPTZ)
```

Default columns **To Do**, **In Progress**, and **Done** are seeded on first run.
Data is stored under `data/pgdata/` and survives restarts.
