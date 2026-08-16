# Realtime Message Board

A fast, local-first collaborative message board. Users post text messages and every
connected client sees updates instantly. Built with an embedded
[PGLite](https://github.com/electric-sql/pglite) PostgreSQL database running inside the
Node.js process and real-time delivery powered by **Server-Sent Events (SSE)**.

## Architecture

```
┌────────────┐    POST /api/messages     ┌─────────────────────────────┐
│            │ ─────────────────────────▶│  Express server (Node.js)   │
│  Browser   │    GET  /api/messages     │  ┌───────────────────────┐  │
│  (Vanilla  │ ◀─────────────────────────│  │ Embedded PGLite (WASM)│  │
│   JS SPA)  │    GET  /api/stream (SSE) │  │  -> ./data on disk     │  │
│            │ ◀═════════════════════════│  └───────────────────────┘  │
└────────────┘    live message events    └─────────────────────────────┘
```

- **Decision 1 – Embedded PGLite:** PostgreSQL runs in-process, persisting to the local
  filesystem (`server/data`). No separate database service to install.
- **Decision 2 – SSE over WebSockets:** Only one-way server→client push is needed, so SSE
  keeps things simple over plain HTTP. Clients post messages with ordinary HTTP POSTs.
- **Decision 3 – Vanilla JS + Vite:** Minimal UI, tiny dependency tree, instant builds.

## Project layout

```
.
├── package.json        # root scripts (run server + client together)
├── server/             # Express + PGLite + SSE backend
│   ├── package.json
│   └── src/
│       ├── index.js    # server entrypoint
│       ├── db.js       # PGLite init + schema
│       └── sse.js      # SSE connection registry / broadcast
└── client/             # Vite + Vanilla JS frontend
    ├── package.json
    ├── index.html
    ├── vite.config.js
    └── src/
        ├── main.js
        └── style.css
```

## Getting started

Install all dependencies (root + server + client):

```bash
npm run install:all
```

Run both the backend and the frontend dev servers together:

```bash
npm run dev
```

- Backend API: http://localhost:3000
- Frontend (Vite dev server): http://localhost:5173

The Vite dev server proxies `/api` requests to the backend, so the SPA talks to the API
through the same origin during development.

## Production

```bash
npm run build          # builds the static client into client/dist
npm start              # serves the API and the built client from the backend
```

When a production build exists in `client/dist`, the Express server serves it directly,
so the whole app is available from http://localhost:3000.

## API

| Method | Path            | Description                                  |
| ------ | --------------- | -------------------------------------------- |
| GET    | `/api/messages` | Fetch all historical messages (oldest first) |
| POST   | `/api/messages` | Create a message `{ "text": "..." }`          |
| GET    | `/api/stream`   | SSE stream that pushes new messages live      |
| GET    | `/api/health`   | Health check                                  |
```
