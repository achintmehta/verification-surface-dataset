# Collaborative Kanban Board

A real-time, multi-user Kanban board built with:

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite) (PostgreSQL on local disk)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + Vite, with native HTML5 drag-and-drop

Multiple clients view the same board and can create cards, move them between
columns, and reorder them within a column. Every mutation is broadcast to all
connected clients so boards converge in real time.

## How it works

### Ordering — fractional positions

Each card carries a numeric `position` within its column. To move a card
between two neighbours, the server computes a value strictly between their
positions (`(after + before) / 2`). This avoids re-indexing the entire column
on each move. Appending uses a fixed step (`+1000`).

If the gap between two neighbours becomes too small to split safely (precision
exhaustion) or a collision occurs, the server **renormalizes** the affected
column to evenly spaced integer positions and broadcasts the corrected order.

### Server-authoritative ordering

Clients send *intent* — "move card X into column C between A and B". The server
computes the canonical `position`, persists `column_id` + `position` atomically
in a single transaction, and broadcasts the canonical card plus the full target
column snapshot. The move and its broadcast reflect only committed state, so no
client ever observes a card in two columns.

### Optimistic UI + reconciliation

The dragging client repositions the card immediately (optimistic update), then
issues the `PATCH /api/cards/:id/move` request. When the server responds (and
when the broadcast arrives), the client snaps the column to the server's
authoritative ordering. The board model enforces a single-column invariant:
every card id lives in exactly one column.

## API

| Method  | Path                      | Body                              | Description                              |
| ------- | ------------------------- | --------------------------------- | ---------------------------------------- |
| `GET`   | `/api/board`              | —                                 | Full board: columns each with cards.     |
| `POST`  | `/api/cards`              | `{ columnId, text }`              | Create a card at the end of a column.    |
| `PATCH` | `/api/cards/:id/move`     | `{ columnId, beforeId, afterId }` | Move/reorder a card; returns canonical.  |
| `GET`   | `/api/stream`             | — (SSE)                           | Stream of `card:create` / `card:move`.   |

## Project layout

```
.
├── package.json        # root scripts (concurrently runs both dev servers)
├── server/             # Express + PGLite backend
│   └── src/
│       ├── index.js    # HTTP + SSE endpoints
│       ├── db.js       # PGLite init, schema, seed data
│       ├── board.js    # board queries + create/move logic
│       ├── ordering.js # fractional position computation
│       └── sse.js      # SSE connection registry + broadcast
└── client/             # Vanilla JS + Vite frontend
    └── src/
        ├── main.js     # rendering + drag-and-drop + SSE wiring
        ├── store.js    # client board model + reconciliation
        ├── api.js      # fetch + EventSource helpers
        └── style.css
```

## Getting started

Install dependencies for the root, server, and client:

```bash
npm run install:all
```

Run both dev servers (backend on `:3001`, frontend on `:5173`):

```bash
npm run dev
```

Open <http://localhost:5173> in two browser windows to see real-time sync.

### Production build

```bash
npm run build          # builds the client into client/dist
npm start              # starts the backend
```

The backend persists state to `server/data/kanban` on local disk. Override the
location with `PGLITE_DATA_DIR` and the port with `PORT`.
