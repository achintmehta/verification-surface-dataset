# Collaborative Kanban Board

A lightweight real-time Kanban board built with Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Features

- Ordered columns and ordered cards.
- Create cards at the end of a column.
- Drag cards within a column or across columns.
- Optimistic UI with server-authoritative reconciliation.
- Real-time convergence for all connected clients via SSE.
- Durable local persistence in `pglite-data/`.
- Fractional card positions with column renormalization when precision/collisions are detected.

## Scripts

```bash
npm start        # run the Express/PGLite server on PORT or 3000
npm run dev      # run backend and Vite frontend concurrently
npm run build    # build frontend assets
npm run preview  # preview built frontend
```

## API

- `GET /api/board` returns columns with their ordered cards.
- `POST /api/cards` with `{ "columnId": "todo", "text": "Task" }` creates a card.
- `PATCH /api/cards/:id/move` with `{ "columnId": "done", "beforeId": null, "afterId": "..." }` moves/reorders a card.
- `GET /api/stream` opens the SSE stream for `card:create` and `card:move` events.
