# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PGLite database and
Server-Sent Events (SSE). Multiple clients converge on the same authoritative
board state in real time.

## Stack

- **Backend**: Node.js + Express, embedded [`@electric-sql/pglite`](https://github.com/electric-sql/pglite) for raw SQL persisted to local disk, SSE for push.
- **Frontend**: Vanilla JS SPA built with Vite, native HTML5 drag-and-drop.

## Architecture

### Ordering
Each card carries a fractional `position` within its column. Moving a card sets
its position to a value between its new neighbours, so most moves touch a single
row. If a gap becomes too small (precision exhaustion) or a collision occurs,
the server **renormalizes** the whole column to evenly-spaced integers and
broadcasts the corrected order via a `column:reorder` event.

### Server is authoritative
Clients send *intent* (`PATCH /api/cards/:id/move` with `{ columnId, beforeId,
afterId }`). The server computes the canonical `position`, persists it inside a
single transaction (so a card is never observable in two columns), and
broadcasts the canonical result. Clients reconcile their optimistic guess.

### Realtime
`GET /api/stream` is an SSE endpoint. Every create/move is broadcast to all
connected clients, which upsert the canonical card into their local store. Since
the store keys cards by id and derives order from `(position, id)`, a card can
only ever render in exactly one column.

## API

| Method | Path                    | Body                                | Description                       |
| ------ | ----------------------- | ----------------------------------- | --------------------------------- |
| GET    | `/api/board`            | —                                   | Full board: columns + cards       |
| POST   | `/api/cards`            | `{ columnId, text }`                | Create a card at end of a column  |
| PATCH  | `/api/cards/:id/move`   | `{ columnId, beforeId, afterId }`   | Move/reorder a card               |
| GET    | `/api/stream`           | —                                   | SSE stream of mutations           |

## Development

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173 in multiple tabs to see real-time convergence.

## Production

```bash
npm install
npm run build    # builds the SPA into dist/
npm start        # serves API + built SPA on :3001
```

Board state is persisted under `data/pgdata/`.
