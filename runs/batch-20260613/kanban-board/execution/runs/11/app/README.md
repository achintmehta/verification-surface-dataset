# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
(PGLite) backend and Server-Sent Events (SSE) for live convergence.

## Stack

- **Backend**: Node.js + Express, embedded [PGLite](https://github.com/electric-sql/pglite) persisting to local disk.
- **Realtime**: Server-Sent Events (server → clients), HTTP for mutations.
- **Frontend**: Vanilla JS SPA bundled with Vite, native HTML5 drag-and-drop.

## How it works

### Ordering (fractional positions)
Each card has a `DOUBLE PRECISION` `position` within its column. Moving a card
between neighbors `A` (above) and `B` (below) assigns a position halfway
between theirs — no full re-index needed. When the gap between two neighbors is
too small to split (precision exhaustion) or a collision occurs, the server
**renormalizes** the whole column to evenly spaced integers and broadcasts the
corrected order.

### Server authority & atomicity
Clients send *intent*: "move card X into column C, between `afterId` and
`beforeId`". The server computes the canonical `position`, updates `column_id`
and `position` **inside a single transaction**, then broadcasts the committed
result. Because the remove-from-source / add-to-target happens atomically, no
client ever observes a card in two columns.

### Optimistic UI + reconciliation
On drop, the client immediately repositions the card locally, then issues the
`PATCH`. The authoritative result arrives both via the HTTP response and the
SSE broadcast; the client snaps its card list to the server's canonical order.
Every mutation detaches the card from any existing location first, enforcing
the "exactly one column" invariant on the client too.

## API

- `GET  /api/board` — full board: ordered columns each with ordered cards.
- `POST /api/cards` — body `{ columnId, text }`; appends a card to the column.
- `PATCH /api/cards/:id/move` — body `{ columnId, beforeId, afterId }`;
  computes canonical position, moves atomically, returns the canonical card
  (and the renormalized column when applicable).
- `GET  /api/stream` — SSE stream emitting `card-created` and `card-moved`.

## Running

```bash
npm install
npm run dev      # runs Express (3001) + Vite (5173) together
```

Open http://localhost:5173 in two browser windows to see live convergence.

### Production

```bash
npm run build    # bundles the frontend to ./dist
npm start        # Express serves the API and the built frontend on :3001
```

## Data

PGLite data is stored in `./.pgdata`. Delete the directory to reset the board.
