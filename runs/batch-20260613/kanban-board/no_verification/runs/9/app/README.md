# Collaborative Kanban Board

A lightweight real-time collaborative Kanban board built with:

- Node.js + Express
- Embedded PGLite persisted on local disk
- Server-Sent Events (SSE) for real-time convergence
- Vanilla JavaScript + Vite for the SPA frontend
- Fractional numeric positions for cheap ordered inserts and moves

## Run

```bash
npm install
npm run dev
```

- Backend API: <http://localhost:3000>
- Vite frontend: <http://localhost:5173>

PGLite persists data under `./data/pglite` by default. Override with `PGLITE_DATA_DIR=/path/to/db`.

## API

- `GET /api/board` — returns columns with ordered cards.
- `POST /api/cards` — `{ "columnId": "todo", "text": "New card" }` creates a card at the end of a column.
- `PATCH /api/cards/:id/move` — `{ "columnId": "done", "beforeId": null, "afterId": "some-card-id" }` moves a card. The server computes the canonical position atomically.
- `GET /api/stream` — SSE stream. Emits `board` and `mutation` events. Mutation events include the canonical card and full authoritative board state so clients always converge.

## Notes

The server is authoritative. Clients optimistically update drag-and-drop actions, then snap to the canonical ordering from SSE/HTTP responses. Moves are wrapped in SQL transactions; broadcasts happen only after commit so clients do not observe a card in two columns. If fractional positions become too close or collide, the affected column is renormalized and the corrected board is broadcast.
