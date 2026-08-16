# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. All connected clients converge on the same authoritative
board state in real time.

- **Backend**: Node.js + Express, with [PGLite](https://github.com/electric-sql/pglite)
  (embedded PostgreSQL) persisting to local disk.
- **Realtime**: Server-Sent Events (SSE) push every mutation to all clients.
- **Frontend**: Vanilla JS Single Page App built with Vite, native HTML5
  drag-and-drop.

## Architecture

### Ordering — fractional positions
Each card carries a `DOUBLE PRECISION` `position` within its column. Inserting
a card between two others picks a value midway between their positions, so a
move only updates a single row instead of re-indexing the column.

When the gap between two neighbors becomes too small (precision exhaustion) or a
position collision is detected, the server **renormalizes** the affected
column to evenly spaced positions and broadcasts the corrected order.

### Server-authoritative ordering
Clients send *intent*: "move card X into column C, between card A (`afterId`)
and card B (`beforeId`)". The server computes the canonical `position`, updates
`column_id` + `position` **atomically in a single transaction**, and broadcasts
the canonical result. No client can ever observe the same card in two columns,
because the remove-from-source / add-to-target happens in one committed
transaction and broadcasts reflect only committed state.

### Optimistic UI + reconciliation
The dragging client repositions the card immediately in its local model and
re-renders. It then issues the HTTP move and, on the canonical response (and via
SSE for every client), snaps each affected column to the server's exact order.
The client model keeps each card in exactly one column array, so the rendered
DOM can never show a card in two places.

## Project layout

```
.
├── package.json        # root scripts (run both dev servers)
├── server/             # Express + PGLite + SSE backend
│   └── src/
│       ├── index.js    # HTTP routes + SSE endpoint
│       ├── db.js       # PGLite init, schema, seed columns
│       ├── board.js    # ordering / move / renormalize logic
│       └── sse.js      # SSE connection registry + broadcast
└── client/             # Vite Vanilla JS frontend
    └── src/
        ├── main.js     # rendering, drag-and-drop, SSE
        ├── store.js    # client board model (single-location invariant)
        ├── api.js      # HTTP wrapper
        └── style.css
```

## Setup

```bash
# install root + server + client dependencies
npm run install:all
```

## Development

```bash
# runs the backend (http://localhost:3001) and the Vite dev server
# (http://localhost:5173) concurrently
npm run dev
```

Open http://localhost:5173 in two browser windows to see real-time sync.
The Vite dev server proxies `/api/*` to the backend.

## Production-ish run

```bash
npm run build          # build the client into client/dist
npm start              # start the backend (serves the API)
```

## API

| Method | Path                    | Body                                   | Description |
| ------ | ----------------------- | -------------------------------------- | ----------- |
| GET    | `/api/board`            | —                                      | Full board: columns each with ordered cards |
| POST   | `/api/cards`            | `{ columnId, text }`                   | Create a card at the end of a column |
| PATCH  | `/api/cards/:id/move`   | `{ columnId, beforeId, afterId }`      | Move/reorder a card; returns canonical card + affected column orders |
| GET    | `/api/stream`           | —                                      | SSE stream of `card:create` and `card:move` events |

### SSE events

- `card:create` → `{ card, columnId }`
- `card:move`   → `{ card, columnId, columns: { [columnId]: orderedCards } }`

## Configuration

- `PORT` — backend port (default `3001`)
- `PGLITE_DATA_DIR` — directory for the embedded database
  (default `server/data/kanban`)
- `API_TARGET` — backend target for the Vite dev proxy
  (default `http://localhost:3001`)
