# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)
- **Real-time sync**: Server-Sent Events (SSE)

## Features

- Shared board with three columns: **To Do**, **In Progress**, **Done**
- Create cards via the "+ Add a card" button in each column
- Drag-and-drop cards within and across columns
- Optimistic UI updates with server-authoritative reconciliation
- All connected clients converge to the same board state in real time
- Board state persisted to disk via PGLite (survives server restarts)

## Getting Started

```bash
# Install dependencies
npm install

# Start both the backend server and the Vite dev server
npm run dev
```

Then open [http://localhost:5173](http://localhost:5173) in one or more browser tabs.

- The **Express server** runs on port `3001`
- The **Vite dev server** runs on port `5173` and proxies `/api/*` to the backend

## Architecture

### Backend (`server/`)

| File | Purpose |
|------|---------|
| `index.js` | Express app setup and boot |
| `db.js` | PGLite singleton, schema init, position helpers |
| `sse.js` | SSE client registry and broadcast |
| `routes/board.js` | `GET /api/board` |
| `routes/cards.js` | `POST /api/cards`, `PATCH /api/cards/:id/move` |

### Frontend (`client/src/`)

| File | Purpose |
|------|---------|
| `main.js` | Boot, wires all modules together |
| `api.js` | HTTP client for the backend API |
| `state.js` | Client-side board state store |
| `board.js` | DOM rendering and reconciliation |
| `dragdrop.js` | Pointer-event drag-and-drop |
| `sse.js` | SSE connection and event dispatch |

### Data flow

```
User drags card
  → optimisticMove() updates state immediately
  → reconcileColumn() re-renders affected columns
  → PATCH /api/cards/:id/move sent to server
      → server computes authoritative position in a transaction
      → broadcasts card:moved via SSE to ALL clients
          → applyCardMoved() updates state
          → reconcileColumn() snaps DOM to canonical order
```

### Position ordering

Cards use a `DOUBLE PRECISION position` column.  Inserting between two cards
uses the midpoint of their positions (fractional indexing).  When the gap
becomes too small (< 1e-9), the server renormalises the column to evenly-spaced
integers and broadcasts the corrected order.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend + frontend in watch mode |
| `npm run dev:server` | Start only the Express server |
| `npm run dev:client` | Start only the Vite dev server |
| `npm run build` | Build the frontend for production |
| `npm start` | Start the Express server (production) |
