# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view one shared board and
can create cards, move them between columns, and reorder them within a column via
drag-and-drop. All connected clients converge on the same authoritative state in
real time.

## Stack

- **Backend:** Node.js + Express, with [PGLite](https://github.com/electric-sql/pglite)
  (PostgreSQL embedded in Node) persisting board state to local disk.
- **Real-time:** Server-Sent Events (SSE) push every committed mutation to all clients.
- **Frontend:** Vanilla JS SPA built with Vite, native HTML5 drag-and-drop.

## Design

### Fractional position ordering
Each card carries a numeric `position` within its column. Inserting between two
cards uses the midpoint of their positions, so a move never re-indexes the whole
column. If the midpoint collides or numeric precision is exhausted, the server
**renormalizes** the affected column (positions reset to 1000, 2000, 3000, …) and
broadcasts the corrected order.

### Server-authoritative ordering
Clients send *intent* — "move card X into column C between A and B". The server
computes the canonical `position`, updates `column_id` + `position` atomically in
a single transaction, and broadcasts the committed result. Because the column
change and position change happen in one `UPDATE` inside one transaction, a card
is **never** observable in two columns.

### Optimistic UI + reconciliation
The dragging client repositions the card immediately, then `PATCH`es the server.
When the canonical card (and any renormalized column) arrives — via the HTTP
response and via SSE — the client snaps its local model to the server's order.
Rendering is always derived from a single client-side model in which each card
lives in exactly one column, so a card can never render in two places.

## API

| Method | Path                    | Body                                  | Description                          |
| ------ | ----------------------- | ------------------------------------- | ------------------------------------ |
| GET    | `/api/board`            | —                                     | Columns, each with ordered cards     |
| POST   | `/api/cards`            | `{ columnId, text }`                  | Create a card at the end of a column |
| PATCH  | `/api/cards/:id/move`   | `{ columnId, beforeId, afterId }`     | Move/reorder a card (authoritative)  |
| GET    | `/api/stream`           | —                                     | SSE stream of `card:create` / `card:move` |

`beforeId` is the card the moved card should precede; `afterId` is the card it
should follow. Either may be `null` (start/end of the column).

## Schema

```sql
columns(id TEXT PK, title TEXT, position DOUBLE PRECISION)
cards(id TEXT PK, column_id TEXT FK, text TEXT, position DOUBLE PRECISION, created_at TIMESTAMPTZ)
```

Default columns (**To Do**, **In Progress**, **Done**) are seeded on first run.

## Running

```bash
npm install

# Run backend (3001) + Vite dev server (5173) together:
npm run dev

# Then open http://localhost:5173
```

The Vite dev server proxies `/api/*` to the backend on port 3001. Open the page
in two tabs/browsers to watch real-time convergence.

Other scripts:

```bash
npm run dev:server   # backend only (http://localhost:3001)
npm run dev:client   # frontend dev server only
npm run build        # build the SPA into ./dist
npm start            # run the backend in production mode
```

Board state is persisted to `./.pgdata` on local disk and survives restarts.
