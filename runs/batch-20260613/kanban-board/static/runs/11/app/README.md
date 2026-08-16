# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view the same board and
can create cards and drag-and-drop them between and within columns. All clients
converge on the same state in real time.

## Stack

- **Backend**: Node.js + Express, embedded [PGLite](https://pglite.dev) for raw
  SQL persistence to local disk.
- **Realtime**: Server-Sent Events (SSE) push every mutation to all clients.
- **Frontend**: Vanilla JS via Vite, native drag-and-drop, optimistic updates
  reconciled against server-authoritative ordering.

## Architecture

### Ordering — fractional positions

Each card has a numeric `position` within its column. Inserting between two
cards uses the midpoint of their positions, so a move only rewrites a single
row instead of re-indexing the whole column. See `server/ordering.js`.

When two positions get too close to fit a new value with adequate floating-point
precision (or otherwise collide), the server **renormalizes** the affected
column to evenly spaced positions inside the same transaction and broadcasts the
corrected order. See `renormalizeColumn` in `server/board.js`.

### Server-authoritative ordering

Clients send *intent*: "move card X into column C between A and B". The server
computes the canonical `position`, persists `column_id` + `position` atomically
in one transaction, and broadcasts the canonical card **and** the full ordered
target column. Clients reconcile their optimistic guess against this.

### Atomic moves

A move runs inside a single `db.transaction`. The reparent + reposition is one
`UPDATE`, so a card is never committed in two columns. Broadcasts only happen
after the transaction commits, so no client ever observes a duplicated card.

### Convergence

- A card carries exactly one `columnId`, so it can only render in one column.
- Each column's order is derived by sorting its cards by `position`, with a
  deterministic `(createdAt, id)` tie-break, giving a **total, stable** order.
- Concurrent moves are serialized by the server; the last committed move wins
  and is broadcast, so every client ends up identical.

## API

- `GET  /api/board` → `{ columns: [{ id, title, position, cards: [...] }] }`
- `POST /api/cards` `{ columnId, text }` → creates a card at the end of a column.
- `PATCH /api/cards/:id/move` `{ columnId, beforeId, afterId }` → moves/reorders.
- `GET  /api/stream` → SSE stream of `card:created` and `card:moved` events.

## Running

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Then open http://localhost:5173 in two browser windows to see real-time sync.

For a production-style run:

```bash
npm run build    # builds the frontend into dist/
npm start        # starts the backend on :3001
```

Board state is persisted to `./.pgdata` (override with `PGLITE_DIR`).
