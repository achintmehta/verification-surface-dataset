# Collaborative Kanban Board

A small real-time Kanban application built with Express, embedded PGLite, SSE, and a vanilla JavaScript/Vite frontend.

## Scripts

- `npm start` - start the Express API/server on port 3000.
- `npm run dev` - run the backend and Vite frontend together.
- `npm run build` - build the frontend into `dist/` for serving by the backend.

## API

- `GET /api/board` returns columns with ordered cards.
- `POST /api/cards` creates a card: `{ "columnId": "todo", "text": "..." }`.
- `PATCH /api/cards/:id/move` moves/reorders a card: `{ "columnId": "done", "beforeId": null, "afterId": "..." }`.
- `GET /api/stream` opens an SSE stream for committed board updates.

PGLite writes durable data to `.pglite-data/` by default.
