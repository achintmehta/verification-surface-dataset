# PGLite SSE Kanban Board

A lightweight collaborative Kanban board built with a Node/Express backend, embedded PGLite persistence, Server-Sent Events for real-time updates, and a vanilla JavaScript/Vite frontend.

## Features

- Ordered columns with ordered cards
- Create cards in any column
- Drag-and-drop cards within a column or across columns
- Optimistic UI updates followed by server-authoritative reconciliation
- Durable local persistence in `data/pglite`
- SSE broadcasts for create/move mutations so all connected clients converge to the same state

## Development

```bash
npm install
npm run dev
```

- API server: http://localhost:3000
- Vite client: http://localhost:5173

## Production-style run

```bash
npm run build
npm run server:start
```

The server serves the built frontend from `dist/` and exposes the API under `/api`.

## API

- `GET /api/board` — returns columns and cards ordered by position
- `POST /api/cards` — body `{ "columnId": "todo", "text": "Card text" }`
- `PATCH /api/cards/:id/move` — body `{ "columnId": "done", "beforeId": null, "afterId": "other-card-id" }`
- `GET /api/stream` — SSE stream with `card:create`, `card:move`, and `board` events
