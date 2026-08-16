# Collaborative Kanban Board

A greenfield multi-user Kanban board demonstrating a traditional client-server app with real-time convergence:

- Node.js + Express backend
- Embedded PGLite persisted to `./.pglite`
- Raw SQL schema for ordered columns and cards
- Server-Sent Events (`GET /api/stream`) for real-time broadcasts
- Vanilla JavaScript + Vite frontend
- Optimistic drag-and-drop moves reconciled against server-authoritative board state

## Scripts

```bash
npm install
npm run dev      # Express API on :3000 and Vite frontend on :5173
npm run build    # Build frontend
npm start        # Start backend; serves dist/ if built
```

## API

- `GET /api/board` returns all columns with ordered cards.
- `POST /api/cards` with `{ "columnId": "todo", "text": "..." }` creates a card at the end of a column.
- `PATCH /api/cards/:id/move` with `{ "columnId", "beforeId", "afterId" }` moves/reorders a card. The server computes the canonical fractional position transactionally.
- `GET /api/stream` opens an SSE stream. Each mutation broadcasts the canonical card plus the full committed board snapshot so clients converge without duplication.

## Ordering model

Cards use numeric fractional positions within their column. The client sends intent (target column and neighboring card IDs); the server writes the authoritative position. If positions collide or become too close, the affected column is renormalized to stable integer-spaced positions and the committed board is broadcast.
