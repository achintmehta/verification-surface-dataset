# Collaborative Kanban Board

A multi-user, real-time Kanban board built with:

- **Backend:** Node.js + Express, embedded **PGLite** for durable on-disk SQL storage, **Server-Sent Events (SSE)** for real-time push.
- **Frontend:** Vanilla JS SPA (Vite) with native HTML5 drag-and-drop, optimistic updates, and reconciliation against server-authoritative ordering.

## Architecture

### Ordering — fractional positions
Each card has a `DOUBLE PRECISION` `position` within its column. Inserting
between two cards uses the midpoint of their positions, so a move never requires
re-indexing the whole column. When a midpoint becomes unrepresentable (precision
exhaustion / collision), the server **renormalizes** the affected column to
evenly spaced integers and broadcasts the corrected order.

### Server is authoritative
Clients send *intent*: "move card X into column C between cards A and B"
(`afterId` / `beforeId`). The server computes the canonical `position`, applies
the column + position change **atomically in a transaction**, and broadcasts the
committed result — including the full ordered card lists of every affected
column. Clients snap their optimistic state to this canonical state, so a card
can never be observed in two columns simultaneously.

### Real-time sync — SSE
`GET /api/stream` holds an `EventSource` connection per client. Every `create`
and `move` is broadcast to all clients as a committed event.

## API

| Method | Path                    | Body                              | Description                              |
| ------ | ----------------------- | --------------------------------- | ---------------------------------------- |
| GET    | `/api/board`            | —                                 | Full board: ordered columns + cards.     |
| POST   | `/api/cards`            | `{ columnId, text }`              | Create a card at the end of a column.    |
| PATCH  | `/api/cards/:id/move`   | `{ columnId, afterId, beforeId }` | Move/reorder a card. Returns canonical.  |
| GET    | `/api/stream`           | —                                 | SSE stream of `card:create`/`card:move`. |

## Running

```bash
npm install
npm run dev      # runs backend (:3000) and Vite frontend (:5173) together
```

Open http://localhost:5173 in multiple tabs/windows to see real-time sync.

Production-style:

```bash
npm run build    # builds the frontend into ./dist
npm start        # runs the backend on :3000
```

The database is persisted to `./.data/kanban` (configurable via `PGLITE_DIR`).
