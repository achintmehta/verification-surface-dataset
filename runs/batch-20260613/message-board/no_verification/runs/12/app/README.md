# Realtime Message Board

A lightweight, local-first collaborative message board. Users post text
messages over plain HTTP and every connected client sees new messages instantly
through **Server-Sent Events (SSE)**. Data is stored persistently on the local
disk using **embedded PGLite** — no external database service required.

## Architecture

```
client (Vite + Vanilla JS)            server (Node.js + Express)
┌────────────────────────┐           ┌───────────────────────────────┐
│  GET  /api/messages ───┼──────────►│  fetch history from PGLite     │
│  POST /api/messages ───┼──────────►│  insert row → broadcast (SSE)  │
│  EventSource /stream ◄─┼───────────┤  keep-alive SSE connections    │
└────────────────────────┘           └───────────────────────────────┘
                                              │
                                       embedded PGLite
                                       (server/data/board on disk)
```

- **Backend** — Express server (`server/`) with an embedded PGLite database.
  - `GET  /api/messages` — full message history (initial state).
  - `POST /api/messages` — insert a message, then broadcast it to all clients.
  - `GET  /api/stream`   — long-lived SSE connection for realtime updates.
- **Frontend** — Vite + Vanilla JS SPA (`client/`).
  - Loads history on startup, opens an `EventSource`, appends live messages,
    and posts new messages via `fetch`.

## Prerequisites

- Node.js 18+ (uses `node --watch` and native ESM).

## Getting started

Install all dependencies (root, server and client):

```bash
npm run install:all
```

Run both the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: <http://localhost:5173>
- Backend API: <http://localhost:3001>

The Vite dev server proxies `/api/*` requests to the backend, so the frontend
uses same-origin relative URLs in both dev and production.

## Production

Build the static frontend and run the backend:

```bash
npm run build          # outputs client/dist
npm start              # starts the Express backend
```

Serve `client/dist` with any static host (or behind a reverse proxy that
forwards `/api` to the Node server).

## Configuration

| Variable           | Default                      | Description                              |
| ------------------ | ---------------------------- | ---------------------------------------- |
| `PORT`             | `3001`                       | Backend HTTP port.                       |
| `PGLITE_DATA_DIR`  | `server/data/board`          | Where PGLite persists its data on disk.  |
| `VITE_API_TARGET`  | `http://localhost:3001`      | Backend target for the Vite dev proxy.   |

## Database schema

```sql
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
