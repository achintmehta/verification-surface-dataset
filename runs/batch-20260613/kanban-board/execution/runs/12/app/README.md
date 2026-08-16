# Collaborative Kanban Board

A multi-user, real-time collaborative Kanban board built with:

- **Backend:** Node.js + Express, embedded **PGLite** (PostgreSQL in-process) persisted to local disk.
- **Real-time sync:** **Server-Sent Events (SSE)** push every mutation to all clients.
- **Frontend:** Vanilla JS + Vite SPA with native HTML5 drag-and-drop.

## Architecture

- **Fractional position ordering** — each card has a `DOUBLE PRECISION` `position`
  within its column. Inserting between two cards uses the midpoint of their
  positions, so moves are O(1) and avoid full re-indexing.
- **Server-authoritative ordering** — clients send intent
  (`{ columnId, beforeId, afterId }`); the server computes the canonical
  position in a single transaction and broadcasts the committed result.
- **Atomic cross-column moves** — `column_id` and `position` are updated in one
  transaction, so no client ever observes a card in two columns.
- **Renormalization** — when fractional positions exhaust precision or collide,
  the server renormalizes the column to evenly spaced integers and broadcasts
  the corrected order; clients snap to it.
- **Optimistic UI** — the dragging client repositions the card immediately, then
  reconciles against the server's canonical position.

## Getting started

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173 in two or more browser windows.

### Production

```bash
npm run build    # build the SPA into dist/
npm start        # Express serves the API, SSE, and the built SPA on :3001
```

## API

| Method | Endpoint                | Description                                       |
| ------ | ----------------------- | ------------------------------------------------ |
| GET    | `/api/board`            | Full board: columns each with ordered cards      |
| POST   | `/api/cards`            | Create a card `{ columnId, text }` at column end  |
| PATCH  | `/api/cards/:id/move`   | Move/reorder `{ columnId, beforeId, afterId }`    |
| GET    | `/api/stream`           | SSE stream of `card.created` / `card.moved`       |

## Data

PGLite writes to `./.data/kanban` by default (override with `PGLITE_DIR`).
Default seeded columns: **To Do**, **In Progress**, **Done**.
