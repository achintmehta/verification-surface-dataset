# Collaborative Kanban Board

A multi-user, real-time collaborative Kanban board. Multiple clients view the
same board and can create cards, move them between columns, and reorder them
within a column via drag-and-drop. All connected clients converge on the same
authoritative board state in real time.

- **Backend**: Node.js + Express, embedded [PGLite](https://pglite.dev) for raw
  SQL persisted to local disk.
- **Real-time sync**: Server-Sent Events (SSE) push every mutation to all
  clients.
- **Frontend**: Vanilla JS Single Page Application built with Vite, with native
  HTML5 drag-and-drop.
- **Ordering**: Fractional `position` values per card; the server is
  authoritative and renormalizes a column when fractional precision is
  exhausted.

## Architecture

```
client (Vite, Vanilla JS)            server (Express + PGLite)
  ├─ GET  /api/board   ─────────────▶ returns columns + ordered cards
  ├─ POST /api/cards   ─────────────▶ create card at end of column
  ├─ PATCH /api/cards/:id/move ─────▶ atomic move; computes canonical position
  └─ GET  /api/stream  ◀──────────── SSE: card:create / card:move broadcasts
```

### Ordering & concurrency model

- Each card has a numeric `position` within its column. Inserting between two
  cards picks a value **between** their positions, so moves are cheap and avoid
  re-indexing an entire column.
- The client sends *intent*: "place card X in column C, after `afterId`, before
  `beforeId`". The **server** computes the final canonical `position`, persists
  it atomically in a transaction, and broadcasts the canonical card plus the
  full ordered target column.
- If the gap between two neighbors becomes too small (precision exhaustion) or a
  collision is detected, the server **renormalizes** the affected column to
  evenly-spaced integers and broadcasts the corrected order.
- A move (remove from source + add to target) is a single `UPDATE` inside one
  transaction, so no client ever observes a card in two columns.
- Clients apply **optimistic** updates on drop, then reconcile against the
  server's authoritative ordering when the response/broadcast arrives.

## Getting started

Requires Node.js 18+.

```bash
# Install root, server, and client dependencies
npm run install:all

# Run backend (port 3001) and frontend (port 5173) together
npm run dev
```

Then open http://localhost:5173 in two or more browser windows and drag cards
around — every window stays in sync.

### Individual commands

```bash
npm --prefix server run dev    # backend with --watch
npm --prefix client run dev    # Vite dev server (proxies /api to :3001)

npm --prefix client run build  # production build to client/dist
npm --prefix server start      # production server
```

## API

| Method  | Path                    | Body                                  | Description                                  |
| ------- | ----------------------- | ------------------------------------- | -------------------------------------------- |
| `GET`   | `/api/board`            | —                                     | Full board: columns each with ordered cards. |
| `POST`  | `/api/cards`            | `{ columnId, text }`                  | Create a card at the end of a column.        |
| `PATCH` | `/api/cards/:id/move`   | `{ columnId, beforeId, afterId }`     | Move/reorder a card; returns canonical state.|
| `GET`   | `/api/stream`           | —                                     | SSE stream of `card:create` / `card:move`.   |

`beforeId` is the card that ends up directly **below** the moved card;
`afterId` is the card directly **above** it. Either may be `null`.

## Persistence

PGLite writes to `server/data/kanban` by default (override with the
`PGLITE_DATA_DIR` env var). The schema is created on first run and the default
columns ("To Do", "In Progress", "Done") are seeded if the board is empty.
Reloading any client reproduces the exact persisted board state.
