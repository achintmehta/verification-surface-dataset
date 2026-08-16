# Kanban Board

A real-time collaborative Kanban board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL, file-system persistence)
- **Real-time sync**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/) (no framework)

## Features

- Shared board with three default columns: **To Do**, **In Progress**, **Done**
- Create cards via the **+ Add a card** button in any column
- **Drag-and-drop** cards within a column (reorder) or across columns (move)
- **Optimistic UI**: the dragging client updates immediately; the server's canonical position is reconciled on confirmation
- **Real-time convergence**: every connected client receives SSE events and updates to the same board state
- **Fractional position ordering** with automatic renormalization to prevent precision exhaustion
- **Durable persistence**: board state survives server restarts (stored in `data/pglite/`)

## Getting Started

### Prerequisites

- Node.js ≥ 18

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

This starts:
- **Backend** on `http://localhost:3001` (with `--watch` for auto-restart)
- **Frontend** on `http://localhost:5173` (Vite HMR)

Open `http://localhost:5173` in one or more browser tabs to see real-time collaboration.

### Production build

```bash
npm run build   # builds the frontend into dist/
npm start       # starts only the backend server
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS + Vite)                            │
│                                                         │
│  store.js ──► render.js ──► DOM                         │
│     ▲              ▲                                    │
│     │              │                                    │
│  sse.js         dragdrop.js                             │
│  (EventSource)  (HTML5 DnD)                             │
│     │              │                                    │
│     │         api.js (fetch)                            │
└─────┼──────────────┼──────────────────────────────────-─┘
      │  SSE push    │  HTTP mutations
┌─────▼──────────────▼──────────────────────────────────-─┐
│  Express Server (Node.js)                               │
│                                                         │
│  GET  /api/board          – full board state            │
│  POST /api/cards          – create card                 │
│  PATCH /api/cards/:id/move – move/reorder card          │
│  GET  /api/stream         – SSE endpoint                │
│                                                         │
│  ordering.js  – fractional positions + renormalization  │
│  sse.js       – client registry + broadcast             │
│  db.js        – PGLite init + schema                    │
└─────────────────────────────────────────────────────────┘
      │
┌─────▼──────────────────────────────────────────────────-┐
│  PGLite (embedded PostgreSQL)                           │
│  data/pglite/  (file-system persistence)                │
│                                                         │
│  columns (id, title, position)                          │
│  cards   (id, column_id, text, position, created_at)    │
└─────────────────────────────────────────────────────────┘
```

## Key Design Decisions

### Fractional position ordering
Each card has a `DOUBLE PRECISION position` within its column. Moving a card between two others uses the midpoint of their positions — no full re-index needed. When the gap between adjacent positions falls below `1e-9`, the column is renormalized (positions spread evenly at intervals of 1000) and all clients receive a `column-reordered` event.

### Server-authoritative ordering
Clients send *intent* (`move card X into column C between A and B`). The server computes the canonical position, persists it atomically in a transaction, and broadcasts the result. Clients reconcile their optimistic guess against this canonical state.

### Atomicity guarantee
Cross-column moves update both `column_id` and `position` in a single `UPDATE` inside a transaction. No client can ever observe a card in two columns simultaneously.

### SSE + HTTP mutations
One-way real-time push (server → clients) via SSE. Mutations are plain HTTP requests. This avoids WebSocket complexity while meeting the real-time requirements.
