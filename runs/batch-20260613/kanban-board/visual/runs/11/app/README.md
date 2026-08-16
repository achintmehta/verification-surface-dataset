# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients view the same board and
can create cards, move them between columns, and reorder them within a column
via drag-and-drop. All connected clients converge on the same authoritative
state in real time.

- **Backend:** Node.js + Express with embedded [PGLite](https://github.com/electric-sql/pglite)
  (PostgreSQL compiled to WASM) persisting to local disk — no external database.
- **Real-time sync:** Server-Sent Events (SSE) push every mutation to all clients.
- **Frontend:** Vanilla JS SPA built with Vite, native HTML5 drag-and-drop.
- **Ordering:** Fractional `position` values so inserts are cheap; the server is
  authoritative and renormalizes a column when fractional precision is exhausted.

## Architecture

```
Browser (SPA)  ──HTTP POST/PATCH──▶  Express  ──SQL──▶  PGLite (on disk)
      ▲                                  │
      └──────────  SSE stream  ◀─────────┘  (broadcast committed state)
```

### Key design points

1. **Fractional position ordering** — each card has a numeric `position` within
   its column. Inserting between two cards uses the midpoint of their positions,
   avoiding a full re-index on every move.
2. **Server is authoritative** — clients send *intent* (`move card X into column
   C between A and B`). The server computes the canonical position from the
   currently persisted neighbor positions, persists atomically, and broadcasts
   the canonical result.
3. **Atomic moves** — `column_id` and `position` are updated in a single
   transaction (a single `UPDATE`), so a card is never observed in two columns.
4. **Renormalization** — if neighbor positions collide or get too close (numeric
   precision exhaustion), the affected column is renormalized to evenly spaced
   positions and the correction is broadcast to all clients.
5. **Optimistic UI** — the dragging client repositions the card immediately, then
   reconciles against the server's canonical position on the SSE echo.

## API

| Method | Path                     | Body                                  | Description |
|--------|--------------------------|---------------------------------------|-------------|
| GET    | `/api/board`             | —                                     | Full board: columns each with ordered cards. |
| POST   | `/api/cards`             | `{ columnId, text }`                  | Create a card at the end of a column. |
| PATCH  | `/api/cards/:id/move`    | `{ columnId, beforeId, afterId }`     | Move/reorder a card. Returns canonical card (+ any renormalized cards). |
| GET    | `/api/stream`            | —                                     | SSE stream of `card:create` and `card:move` events. |

`beforeId` is the card that should end up directly **below** the moved card;
`afterId` the card directly **above** it. Either may be `null` for the ends.

## Database schema

```sql
CREATE TABLE columns (
  id        TEXT PRIMARY KEY,
  title     TEXT NOT NULL,
  position  DOUBLE PRECISION NOT NULL
);

CREATE TABLE cards (
  id         TEXT PRIMARY KEY,
  column_id  TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  position   DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Default columns (`To Do`, `In Progress`, `Done`) are seeded on first boot.
Data is stored under `data/pgdata/`.

## Running

Install dependencies:

```bash
npm install
```

### Development (two dev servers)

Runs the Express backend (port 3001) and the Vite dev server (port 5173) with a
proxy for `/api`:

```bash
npm run dev
```

Open <http://localhost:5173>. Open it in two windows/tabs to see real-time sync.

### Production-style (single origin)

Build the frontend and serve everything from Express:

```bash
npm run build
npm start
```

Open <http://localhost:3001>.

## Convergence smoke test

With the server running:

```bash
node scripts/concurrency-check.js
```

It verifies that concurrent moves of the same card leave it in exactly one
column, that every column has a total/stable/unique ordering, and that
concurrent reorders converge to a single order.

## Acceptance criteria coverage

- **New card appears on every client** — `POST /api/cards` broadcasts `card:create`.
- **Cross-column move on all clients, exactly one column** — atomic `UPDATE` of
  `column_id` + `position`; client model is a flat card map keyed by id, so a
  card can only ever belong to one column.
- **Two clients reordering converge** — server-authoritative positions + broadcast.
- **Concurrent moves of the same card** — last write wins on the single card row;
  broadcast canonical state; no duplication or loss.
- **Reload reproduces server state** — `GET /api/board` is the source of truth,
  persisted durably by PGLite.
- **Total, stable ordering** — sort by `position` with `id` tie-break; renormalize
  on collision/precision exhaustion.
```
