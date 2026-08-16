# Collaborative Kanban Board

A small real-time Kanban board built with a Node/Express server, embedded PGLite persistence, Server-Sent Events, and a vanilla JavaScript Vite frontend.

## Features

- Ordered columns and ordered cards.
- Create cards in any column.
- Drag cards within a column or across columns.
- Server-authoritative ordering using fractional numeric positions.
- Atomic move transactions so a card is committed in exactly one column.
- SSE broadcasts after every committed mutation; clients reconcile optimistic DOM changes against the canonical board.
- PGLite data persisted locally under `data/pglite` by default.

## Scripts

```bash
npm install
npm run dev          # backend on :3000 and Vite frontend on :5173
npm run server:start # backend only
npm --prefix client run build
npm start            # serve backend and built frontend
```

Open <http://localhost:5173> during development. API requests and SSE are proxied to the backend.

## API

- `GET /api/board` returns `{ columns: [{ id, title, position, cards: [...] }] }` ordered by position.
- `POST /api/cards` with `{ columnId, text }` creates a card at the end of a column.
- `PATCH /api/cards/:id/move` with `{ columnId, beforeId, afterId }` moves a card. The server computes the authoritative position between `afterId` and `beforeId`.
- `GET /api/stream` streams `board`, `create`, `move`, and `renormalize` events.

Set `PGLITE_DATA_DIR=/path/to/db` to customize the persistence location and `PORT=...` to change the backend port.
