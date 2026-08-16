# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. All connected clients converge on the same authoritative
state in real time.

- **Backend:** Node.js + Express, with an embedded [PGLite](https://github.com/electric-sql/pglite)
  database persisted to local disk.
- **Real-time sync:** Server-Sent Events (SSE) push every mutation to all clients.
- **Frontend:** Vanilla JS SPA built with Vite, native HTML5 drag-and-drop.
- **Ordering:** Fractional `position` values let cards be inserted between
  neighbours without re-indexing. The server is authoritative; clients apply
  optimistic updates and reconcile against canonical state.

## Project layout

```
.
├── package.json        # root scripts (run both dev servers)
├── server/             # Express + PGLite backend
│   └── src/
│       ├── index.js    # HTTP + SSE endpoints
│       ├── db.js       # PGLite init, schema, seed data
│       ├── board.js    # board queries + ordering/concurrency logic
│       └── sse.js      # SSE connection hub
└── client/             # Vite + Vanilla JS frontend
    └── src/
        ├── main.js     # rendering, drag-and-drop, SSE wiring
        ├── store.js    # client-side board model + reconciliation
        ├── api.js      # REST wrappers
        └── style.css
```

## Getting started

Install dependencies for the root, server, and client:

```bash
npm run install:all
```

Run both dev servers (backend on :3001, frontend on :5173):

```bash
npm run dev
```

Open http://localhost:5173 in two browser windows to see live collaboration.
The Vite dev server proxies `/api/*` (including the SSE stream) to the backend.

### Production-ish

Build the frontend and run the backend:

```bash
npm run build
npm start
```

## API

| Method | Path                     | Description                                            |
| ------ | ------------------------ | ------------------------------------------------------ |
| GET    | `/api/board`             | Full board: ordered columns each with ordered cards.   |
| POST   | `/api/cards`             | Create a card `{ columnId, text }` at end of a column. |
| PATCH  | `/api/cards/:id/move`    | Move a card `{ columnId, beforeId, afterId }`.          |
| GET    | `/api/stream`            | SSE stream of `card-created` / `card-moved` events.     |

## Ordering & concurrency

- **Fractional positions:** A card's `position` is a `DOUBLE PRECISION` value.
  Inserting between two cards uses the midpoint of their positions.
- **Server-authoritative:** Clients send *intent* (move card X between A and B).
  The server computes the canonical position, persists it in a transaction, and
  broadcasts the result. Clients replace their optimistic guess with this.
- **Atomic moves:** Column change + position update happen in one transaction,
  so no client ever observes a card in two columns.
- **Renormalization:** If two positions collide or the gap shrinks below a
  precision threshold, the server re-spaces the whole column to even integers
  and broadcasts the corrected order, which clients adopt wholesale.

## Data persistence

PGLite writes to `server/data/kanban/` by default (override with the
`PGLITE_DIR` env var). Reloading any client reproduces the server's exact
board state.
