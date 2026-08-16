# Collaborative Kanban Board

A multi-user, real-time Kanban board built with an embedded PostgreSQL
(PGLite) backend, Server-Sent Events for live convergence, and a Vanilla JS
(Vite) drag-and-drop frontend.

## Architecture

- **Backend** (`server/`): Express + `@electric-sql/pglite`.
  - `db.js` — initializes embedded PGLite (persisted to `./data/kanban`),
    creates the `columns` and `cards` schema, and seeds default columns.
  - `board.js` — board reads, card creation, and the authoritative move logic
    using **fractional positions** with renormalization on precision
    exhaustion. Moves run inside a single transaction.
  - `sse.js` — manages active SSE connections and broadcasts canonical events.
  - `index.js` — HTTP routes and the SSE stream.
- **Frontend** (`client/`): Vanilla JS SPA.
  - Renders declaratively from a local store that mirrors the server's
    `ORDER BY position, id`. A card is a single record keyed by id, so it can
    never appear in two columns.
  - Optimistic drag-and-drop, reconciled against the server's canonical
    position via the move response and SSE broadcasts.

## API

- `GET  /api/board` — full board: columns (ordered) each with ordered cards.
- `POST /api/cards` — `{ columnId, text }` → creates a card at column end.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }` → computes the
  canonical fractional position between neighbours, persists atomically, and
  returns the canonical card (plus a renormalized column when required).
- `GET  /api/stream` — SSE stream of `card:create`, `card:move`, and
  `column:normalize` events.

## Ordering & concurrency

- **Fractional positions**: a move places a card at the midpoint between its
  new neighbours' positions, avoiding full re-indexing.
- **Precision exhaustion / collision**: when the gap between neighbours is too
  small, the server renormalizes the entire column to evenly spaced positions
  and broadcasts the corrected order.
- **Atomicity**: each move removes-and-reinserts the card in one transaction;
  only committed state is broadcast, so no client ever sees a card in two
  columns.
- **Authoritative server**: clients send intent; the server decides the final
  position and clients snap to it.

## Running

```bash
npm install
npm run dev      # runs backend (3000) + Vite dev server (5173) together
```

Open multiple browser tabs at http://localhost:5173 to see real-time
convergence.

For production-style serving:

```bash
npm run build    # builds the client into ./dist
npm start        # runs the backend
```
