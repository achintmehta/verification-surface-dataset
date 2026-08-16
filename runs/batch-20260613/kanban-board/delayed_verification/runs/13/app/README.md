# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
(PGLite) backend and Server-Sent Events for live synchronization. The
frontend is a lightweight Vanilla JS SPA powered by Vite with native
drag-and-drop.

## Architecture

- **Backend** (`server/`): Express + `@electric-sql/pglite`.
  - `db.js` — initializes PGLite (persisted to `./data/kanban`), creates the
    `columns` and `cards` schema, and seeds default columns.
  - `board.js` — core ordering & concurrency logic: fractional `position`
    ordering, atomic moves in a transaction, and column renormalization on
    precision exhaustion / collisions.
  - `sse.js` — Server-Sent Events broadcaster (active connection registry).
  - `index.js` — HTTP API + SSE endpoint wiring.
- **Frontend** (`client/`): Vanilla JS + Vite.
  - Renders columns/cards from `GET /api/board`.
  - Drag-and-drop with optimistic repositioning.
  - `EventSource` SSE consumer that reconciles every client to the server's
    canonical state.

## Key design points

- **Fractional positions**: cards carry a `DOUBLE PRECISION` `position`.
  Inserting between two cards uses the midpoint, avoiding full re-indexing.
- **Server-authoritative ordering**: clients send intent
  (`{ columnId, beforeId, afterId }`); the server computes the canonical
  position, persists `column_id`+`position` atomically in a transaction, and
  broadcasts the result.
- **Atomic cross-column moves**: a card is a single row keyed by `id`, so a
  move is a single `UPDATE`; a card can never exist in two columns.
- **Renormalization**: when the gap between neighbours is exhausted, the
  affected column's positions are rewritten to evenly spaced integers and the
  corrected ordering is broadcast (`column-renormalized`).

## API

| Method | Path                     | Description                                  |
| ------ | ------------------------ | -------------------------------------------- |
| GET    | `/api/board`             | Full board: columns each with ordered cards. |
| POST   | `/api/cards`             | `{ columnId, text }` → create card at end.   |
| PATCH  | `/api/cards/:id/move`    | `{ columnId, beforeId, afterId }` → move.    |
| GET    | `/api/stream`            | SSE stream of `card-created`, `card-moved`, `column-renormalized`. |

## Running

```bash
npm install
# Dev: backend (3001) + Vite dev server (5173) with API proxy
npm run dev
```

Open http://localhost:5173 in multiple tabs/browsers to see real-time sync.

For a production-style run:

```bash
npm run build   # builds client into ./dist
npm start       # Express serves the API, SSE, and the built SPA on :3001
```
