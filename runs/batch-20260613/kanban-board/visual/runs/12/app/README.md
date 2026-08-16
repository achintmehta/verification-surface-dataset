# Collaborative Kanban Board

A real-time, multi-user Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. All clients converge on the same authoritative state in real
time.

- **Backend**: Node.js + Express, embedded **PGLite** (persisted to local disk),
  **Server-Sent Events** for push.
- **Frontend**: Vanilla JS SPA built with **Vite**, native HTML5 drag-and-drop,
  optimistic updates reconciled against server-authoritative ordering.

## Architecture

### Ordering (fractional positions)

Each card has a numeric `position` within its column. Inserting between two
cards uses a value halfway between their positions, so a move only rewrites a
single row — no full re-index. The server is authoritative: clients send intent
(`move card X into column C between A and B`), the server computes the canonical
`position`, persists it atomically, and broadcasts the result.

When neighbouring positions get too close (precision exhaustion) or collide, the
server **renormalizes** the whole column to evenly-spaced positions inside the
same transaction and broadcasts the corrected order (`column-reordered`).

### Atomic moves

A move runs in a single SQL transaction (`BEGIN`/`COMMIT`). The card's
`column_id` and `position` are updated together, so no client can ever observe
the same card in two columns. Only committed state is broadcast.

### Real-time sync (SSE)

Clients open `GET /api/stream` (an `EventSource`). The server broadcasts:

- `card-created`  — `{ card }`
- `card-moved`    — `{ card }` (canonical column + position)
- `column-reordered` — `{ columnId, cards }` (after a renormalization)

Because each event carries the canonical `column_id`, applying it to the client
model overwrites any stale placement, guaranteeing a card renders in exactly one
column.

### Optimistic UI

On drop, the dragging client immediately repositions the card using a guessed
fractional position, then `PATCH`es the server. When the canonical response (and
the broadcast) arrive, the client snaps the card to the server's authoritative
position.

## API

| Method | Path                     | Body                                   | Description |
|--------|--------------------------|----------------------------------------|-------------|
| GET    | `/api/board`             | —                                      | Full board: columns (ordered) each with ordered cards |
| POST   | `/api/cards`             | `{ columnId, text }`                   | Create a card at the end of a column |
| PATCH  | `/api/cards/:id/move`    | `{ columnId, beforeId, afterId }`      | Move/reorder a card; returns canonical card |
| GET    | `/api/stream`            | — (SSE)                                | Real-time event stream |

`afterId` is the neighbour that ends up **above** the moved card; `beforeId` the
neighbour **below**. Either may be `null` (top/bottom of column).

## Data model

```sql
columns(id TEXT PK, title TEXT, position DOUBLE PRECISION)
cards(id TEXT PK, column_id TEXT FK, text TEXT,
      position DOUBLE PRECISION, created_at TIMESTAMPTZ)
```

Default seeded columns: **To Do**, **In Progress**, **Done**.
Data is persisted under `.data/pgdata`.

## Running

```bash
npm install

# Development: backend (3001) + Vite dev server (5173, proxies /api to backend)
npm run dev
# open http://localhost:5173

# Production: build the SPA and serve everything from the Node server
npm run build
npm start
# open http://localhost:3001
```

Open the app in two browser windows to see real-time convergence: create/move a
card in one and it appears, in order, in the other.
