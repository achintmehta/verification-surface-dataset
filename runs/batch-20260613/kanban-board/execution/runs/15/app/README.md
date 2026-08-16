# Collaborative Kanban Board

A real-time, multi-user Kanban board built with an embedded PostgreSQL
([PGLite](https://github.com/electric-sql/pglite)) backend and Server-Sent
Events (SSE) for live convergence. The frontend is a lightweight Vanilla JS
SPA (Vite) with drag-and-drop.

## Architecture

```
client (Vite / Vanilla JS)            server (Node + Express)
  ├─ drag & drop UI                     ├─ GET  /api/board         board snapshot
  ├─ optimistic update                  ├─ POST /api/cards         create card
  ├─ EventSource(/api/stream)  ◀──SSE── ├─ PATCH /api/cards/:id/move  move/reorder
  └─ reconcile to canonical             └─ GET  /api/stream        SSE broadcast
                                           └─ PGLite → ./.pgdata (durable disk)
```

### Key decisions

- **Fractional position ordering.** Each card has a `DOUBLE PRECISION`
  `position` within its column. Inserting between two cards uses the midpoint
  of their positions — no full re-index per move.
- **Server is authoritative.** Clients send intent (`columnId`, `beforeId`,
  `afterId`). The server computes the canonical position in a single
  transaction and broadcasts it. Clients reconcile their optimistic guess.
- **Atomic moves.** A move is one `UPDATE` inside a transaction, so a card can
  never be observed in two columns. Only committed state is broadcast.
- **Renormalization.** When a gap is exhausted or positions collide, the
  server renormalizes the whole column to evenly spaced integers and
  broadcasts the corrected order.

## Run

```bash
npm install
npm run dev      # runs backend (3001) + Vite dev server (5173)
```

Open http://localhost:5173 in two browser windows to see live convergence.

### Production-ish

```bash
npm run build    # builds client to ./dist
npm start        # runs the API/SSE server on :3001
```

## API

| Method | Path                  | Body                              | Description                |
| ------ | --------------------- | --------------------------------- | -------------------------- |
| GET    | `/api/board`          | —                                 | Columns with ordered cards |
| POST   | `/api/cards`          | `{ columnId, text }`              | Create card at column end  |
| PATCH  | `/api/cards/:id/move` | `{ columnId, beforeId, afterId }` | Move/reorder a card        |
| GET    | `/api/stream`         | —                                 | SSE event stream           |

SSE events: `card:create` `{ card }`, `card:move` `{ card, renormalized }`.
