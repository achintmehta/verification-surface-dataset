# Collaborative Kanban Board

A lightweight real-time Kanban board built with a Node/Express API, embedded PGLite persistence, Server-Sent Events, and a vanilla Vite frontend.

## Development

```bash
npm install
npm run dev
```

- API: `http://localhost:3000`
- Frontend: `http://localhost:5173`
- Persistent PGLite data: `./data/pglite` by default

## API

- `GET /api/board` returns all columns with cards ordered by canonical `position`.
- `POST /api/cards` with `{ "columnId": "to-do", "text": "..." }` creates a card at the end of a column.
- `PATCH /api/cards/:id/move` with `{ "columnId": "done", "beforeId": null, "afterId": "..." }` moves/reorders a card. The server computes the authoritative position.
- `GET /api/stream` streams authoritative `board`, `create`, and `move` SSE events.

Every mutation is committed before it is broadcast. SSE payloads include the canonical card and full committed board so clients can replace optimistic state and converge.
