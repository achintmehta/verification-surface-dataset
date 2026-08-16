# Realtime Message Board

A fast, local-first collaborative message board demonstrating an **embedded PGLite** PostgreSQL
database combined with **Server-Sent Events (SSE)** for real-time updates. The frontend is a
lightweight Vanilla JS Single Page Application built with Vite.

## Architecture

```
┌─────────────┐     POST /api/messages     ┌──────────────────────────┐
│             │ ─────────────────────────▶ │                          │
│   Browser   │                            │   Express (Node.js)      │
│  (Vanilla   │     GET /api/messages      │                          │
│   JS SPA)   │ ◀───────────────────────── │   ┌──────────────────┐   │
│             │                            │   │  PGLite (WASM)   │   │
│  EventSource│     GET /api/stream (SSE)  │   │  persisted to    │   │
│             │ ◀═════════════════════════ │   │  ./pgdata        │   │
└─────────────┘     live message events    │   └──────────────────┘   │
                                           └──────────────────────────┘
```

- **Backend** (`/server`): Express server with an embedded PGLite database persisted to disk.
  Exposes a REST API for fetching/posting messages and an SSE endpoint for live updates.
- **Frontend** (`/client`): A Vite + Vanilla JS app that renders the message feed, posts new
  messages, and subscribes to live updates over SSE.

## Getting Started

Install all dependencies (root, server, and client):

```bash
npm run install:all
```

Run both the backend and frontend dev servers concurrently:

```bash
npm run dev
```

- Backend runs on `http://localhost:3000`
- Frontend (Vite) runs on `http://localhost:5173` and proxies `/api` to the backend.

Open `http://localhost:5173` in multiple browser tabs and watch messages sync in real time.

## Production

Build the frontend and let the backend serve the static bundle:

```bash
npm run build
npm start
```

Then visit `http://localhost:3000`.

## API

| Method | Endpoint        | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/api/messages` | Fetch all historical messages (oldest → newest).   |
| POST   | `/api/messages` | Post a new message. Body: `{ "text": "..." }`.     |
| GET    | `/api/stream`   | SSE stream that emits `message` events on inserts. |

## Design Notes

- **PGLite vs external Postgres** — PGLite runs PostgreSQL inside the Node process via WASM, so
  there is no separate database service to install or configure. Data is persisted to `./pgdata`.
- **SSE vs WebSockets** — We only need one-way server→client push, so SSE keeps things simple,
  works over plain HTTP, and needs no extra socket library.
- **Vanilla JS vs React** — The UI is a list + a form, so Vanilla JS keeps the build tiny and fast.
