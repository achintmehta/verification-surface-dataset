# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PGLite database,
Server-Sent Events (SSE) for live sync, and a Vanilla JS + Vite frontend with
drag-and-drop.

## Architecture

```
client/  Vanilla JS SPA (Vite) — drag-and-drop UI, optimistic updates, SSE
server/  Express + @electric-sql/pglite — authoritative ordering, SSE broadcast
```

- **Fractional positions**: each card has a `DOUBLE PRECISION` position within
  its column. Moves compute a value between neighbors, so a move never reindexes
  the whole column. If precision is exhausted (adjacent gap < 1e-6) the column
  is renormalized and the corrected order is broadcast.
- **Server-authoritative ordering**: clients send intent
  (`{ columnId, beforeId, afterId }`); the server computes the canonical
  position, commits it in a transaction, and broadcasts the canonical card.
- **Atomic moves**: column change + position update happen in one transaction,
  so no client ever observes a card in two columns.
- **Optimistic UI**: the dragging client repositions the card immediately, then
  reconciles to the server's canonical position when the response/broadcast
  arrives.

## API

| Method | Path                     | Description                              |
| ------ | ------------------------ | ---------------------------------------- |
| GET    | `/api/board`             | Full board: columns each with cards      |
| POST   | `/api/cards`             | Create a card at end of a column         |
| PATCH  | `/api/cards/:id/move`    | Move/reorder a card; returns canonical   |
| GET    | `/api/stream`            | SSE stream of `card:create` / `card:move`/ `column:renormalize` |

## Running locally

```bash
npm run install:all   # install root, server, and client deps
npm run dev           # runs server (3001) + client (5173) concurrently
```

Open http://localhost:5173 in two browser windows to see live convergence.

### Production

```bash
npm run build         # build the client
npm start             # start the server
```

Data is persisted to `server/data/kanban` on disk.
