# Collaborative Kanban Board

A multi-user, real-time Kanban board. Multiple clients see the same board and
can create cards, move them between columns, and reorder them via drag-and-drop.
All connected clients converge on the same authoritative state in real time.

## Architecture

- **Backend**: Node.js + Express, embedded **PGLite** (`@electric-sql/pglite`)
  persisting to local disk.
- **Real-time**: **Server-Sent Events (SSE)** push every mutation to all clients.
- **Frontend**: Vanilla JS SPA built with **Vite**, native HTML5 drag-and-drop.

### Ordering model

Each card has a fractional `position` within its column. Inserting between two
cards uses a value between their positions, so a move only updates a single row.
When fractional precision is exhausted (neighbours too close), the server
**renormalizes** that column to evenly spaced integer positions and broadcasts
the corrected order so every client snaps to it.

### Concurrency model

- Clients send **intent** (`move card X into column C between A and B`).
- The server computes the **canonical** position, persists it in a **single
  transaction** (remove from source / add to target happens atomically), and
  broadcasts the committed result.
- Clients apply an **optimistic** local update on drop, then **reconcile**
  against the server's canonical position when the response / SSE event arrives.

## Endpoints

| Method | Path                    | Purpose                                            |
| ------ | ----------------------- | -------------------------------------------------- |
| GET    | `/api/board`            | Full board: columns (ordered) with cards (ordered) |
| POST   | `/api/cards`            | Create a card at the end of a column               |
| PATCH  | `/api/cards/:id/move`   | Move/reorder a card; returns the canonical card    |
| GET    | `/api/stream`           | SSE stream of `card-created` / `card-moved` / `column-normalized` |
| GET    | `/api/health`           | Health + connected client count                    |

## Running

```bash
npm install
npm run dev      # runs backend (:3001) and Vite frontend (:5173) together
```

Open http://localhost:5173 in multiple tabs/browsers to see real-time sync.

For production:

```bash
npm run build    # builds the frontend into dist/
npm start        # runs the backend (serve dist/ with any static host)
```
