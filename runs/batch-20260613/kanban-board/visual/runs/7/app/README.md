# Collaborative Kanban Board

A lightweight multi-user Kanban board using a Node.js/Express API, embedded PGLite persistence, Server-Sent Events for real-time convergence, and a Vanilla JS/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3001
- Frontend dev server: http://localhost:5173

The PGLite database is stored durably under `data/pglite` by default. Override with `PGLITE_DATA_DIR=/path/to/db`.

## API

- `GET /api/board` — full authoritative board state.
- `GET /api/stream` — SSE stream. Emits `sync`, `card:create`, and `card:move` events, each including a canonical board snapshot.
- `POST /api/cards` — `{ columnId, text }`, creates a card at the end of a column.
- `PATCH /api/cards/:id/move` — `{ columnId, beforeId, afterId }`, moves a card into the target column between the optional neighboring card IDs.

## Ordering and convergence

Cards use fractional numeric positions. Clients optimistically move cards on drop and send move intent; the server serializes mutations, computes canonical positions inside a transaction, persists them, then broadcasts only committed state. If a gap becomes unsafe, the affected column is renormalized and the corrected board snapshot is broadcast.
