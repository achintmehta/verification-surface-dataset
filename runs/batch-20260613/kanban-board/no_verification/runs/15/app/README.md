# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
(PGLite) backend, Server-Sent Events (SSE) for live sync, and a lightweight
Vanilla JS + Vite frontend with drag-and-drop.

## Architecture

- **Backend** (`server/`): Node.js + Express, embedded **PGLite** persisting to
  `data/pgdata` on local disk. Mutations arrive as HTTP requests; the server is
  authoritative on ordering and broadcasts every committed change over SSE.
- **Frontend** (`client/`): Vanilla JS SPA bundled by Vite. Renders columns and
  cards, supports drag-and-drop, applies optimistic updates, and reconciles
  against the server's canonical ordering received via `EventSource`.

### Ordering

Each card has a fractional `position` within its column. Moving a card between
two cards `A` (above) and `B` (below) computes a position between theirs, so
moves never require a full re-index. If two positions collide or the gap shrinks
below a precision threshold, the server **renormalizes** the affected column to
evenly spaced positions and broadcasts the corrected order.

### Atomicity & convergence

A move (`PATCH /api/cards/:id/move`) removes the card from its source column and
places it in the target column with a new position in **a single transaction**.
Only committed state is broadcast, so no client ever sees a card in two columns.
Clients key cards by id with a single `columnId`, guaranteeing a card renders in
exactly one place.

## API

| Method | Path                    | Description                                   |
| ------ | ----------------------- | --------------------------------------------- |
| GET    | `/api/board`            | Full board: ordered columns with their cards. |
| POST   | `/api/cards`            | Create a card `{ columnId, text }`.           |
| PATCH  | `/api/cards/:id/move`   | Move/reorder `{ columnId, beforeId, afterId }`. |
| GET    | `/api/stream`           | SSE stream of `card.created` / `card.moved`.  |

`afterId` is the card directly above the drop slot; `beforeId` is the card
directly below it. Either may be `null` (top/bottom of a column).

## Running

```bash
npm install
npm run dev      # runs backend (:3001) and Vite dev server (:5173) together
```

Open http://localhost:5173 in multiple tabs/browsers to see real-time sync.

To run as a single production server:

```bash
npm run build    # builds the frontend into client/dist
npm start        # serves API + static frontend on :3001
```
