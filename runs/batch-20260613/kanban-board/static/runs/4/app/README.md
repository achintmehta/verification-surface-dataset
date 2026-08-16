# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL, persisted to disk)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/) (no framework)

## Architecture

```
client/          Vite SPA (Vanilla JS)
  src/
    main.js      App bootstrap, SSE wiring, form handlers
    api.js       fetch() wrappers for all HTTP endpoints
    state.js     Client-side board state (immutable updates)
    render.js    DOM rendering & reconciliation
    dragdrop.js  HTML5 Drag-and-Drop module
    sse-client.js EventSource wrapper
    style.css    All styles

server/          Express server
  src/
    index.js     Entry point, Express setup
    db.js        PGLite init, query(), transaction()
    sse.js       SSE connection manager & broadcast()
    ordering.js  Fractional position helpers
    routes/
      board.js   GET /api/board
      cards.js   POST /api/cards, PATCH /api/cards/:id/move
      stream.js  GET /api/stream (SSE)

data/            PGLite database files (auto-created)
```

## Getting Started

```bash
# Install all dependencies (root + workspaces)
npm install

# Run backend + frontend dev servers concurrently
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/board` | Full board snapshot |
| `POST` | `/api/cards` | Create a card `{ columnId, text }` |
| `PATCH` | `/api/cards/:id/move` | Move/reorder `{ columnId, afterId?, beforeId? }` |
| `GET` | `/api/stream` | SSE event stream |

### SSE Events

| Event | Payload |
|-------|---------|
| `board:state` | `{ columns: [...] }` – full snapshot on connect |
| `card:created` | `{ card }` |
| `card:moved` | `{ card }` |
| `column:reordered` | `{ columnId, cards }` – after position renormalisation |

## Design Decisions

### Fractional Position Ordering
Cards carry a `DOUBLE PRECISION position` within their column. Inserting between two cards uses the midpoint of their positions. When adjacent positions get too close (< 1e-9), the server renormalises the column to evenly-spaced positions and broadcasts the corrected order.

### Server-Authoritative Ordering
Clients send intent (`move card X between A and B`). The server computes the canonical position, persists it atomically in a transaction, and broadcasts the result. All clients reconcile their optimistic state against this canonical result.

### Optimistic UI
On drag-and-drop, the card is immediately moved in the DOM (optimistic update). The server's `card:moved` SSE event then reconciles the DOM to the canonical order. If the server position differs from the optimistic guess, the card snaps to the correct slot.

### Atomicity
Cross-column moves update `column_id` and `position` in a single `db.transaction()` call. No client can ever observe a card in two columns simultaneously.
