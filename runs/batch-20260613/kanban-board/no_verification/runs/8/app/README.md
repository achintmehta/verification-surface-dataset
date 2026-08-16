# Collaborative Kanban Board

A greenfield multi-user Kanban board built with:

- Node.js + Express backend
- Embedded PGLite persisted under `data/pglite`
- Server-Sent Events for real-time server-to-client convergence
- Vanilla JavaScript frontend served by Vite
- Fractional card positions for cheap reorder and cross-column moves

## Scripts

```bash
npm install
npm run dev        # Express API on :3001 and Vite client on :5173
npm start          # API only
npm run build      # Build frontend into web/dist
```

Set `VITE_API_URL` for the frontend if the API is not at `http://localhost:3001`.
Set `PORT` or `PGLITE_DATA_DIR` for the backend if desired.

## API

- `GET /api/board` returns ordered columns with ordered cards.
- `POST /api/cards` with `{ "columnId": "todo", "text": "Card text" }` creates a card at the end of a column.
- `PATCH /api/cards/:id/move` with `{ "columnId": "done", "beforeId": null, "afterId": "..." }` moves/reorders using server-authoritative fractional positioning.
- `GET /api/stream` opens an SSE stream. `card:create` and `card:move` events include the canonical card and the full canonical board.
