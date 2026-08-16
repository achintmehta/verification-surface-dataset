# Realtime Message Board

A lightweight, local-first collaborative message board built with:

- **Backend**: Node.js + Express + embedded [PGLite](https://github.com/electric-sql/pglite) (PostgreSQL in WASM, persisted to disk)
- **Realtime**: Server-Sent Events (SSE) for one-way server → client updates
- **Frontend**: Vanilla JS + Vite

No external database service is required — PGLite runs directly inside the Node process and persists data to `server/data/pgdata`.

## Project structure

```
.
├── package.json        # npm workspaces + dev scripts
├── server/             # Express + PGLite backend
│   └── src/
│       ├── index.js    # HTTP routes (REST + SSE)
│       ├── db.js       # PGLite init & schema
│       └── sse.js      # SSE connection broker
└── client/             # Vanilla JS + Vite frontend
    ├── index.html
    └── src/
        ├── main.js     # fetch history, SSE, posting
        └── style.css
```

## Getting started

```bash
npm install        # installs all workspace dependencies
npm run dev        # runs backend (:3001) and frontend (:5173) together
```

Then open http://localhost:5173.

The Vite dev server proxies `/api/*` to the backend, so the frontend uses
same-origin relative URLs. Open the app in multiple tabs to see messages
appear in real time across all of them.

## API

| Method | Path            | Description                                  |
| ------ | --------------- | -------------------------------------------- |
| GET    | `/api/messages` | Fetch historical messages (oldest first).    |
| POST   | `/api/messages` | Create a message. Body: `{ "text": "..." }`. |
| GET    | `/api/stream`   | SSE stream emitting `message` events.        |
| GET    | `/api/health`   | Health check + active connection count.      |

## Production build

```bash
npm run build      # builds the frontend into client/dist
npm start          # starts the backend
```

Serve `client/dist` with any static file server (the backend and frontend can
be hosted separately, or you can place the built assets behind the same origin
as the API).

## Configuration

| Variable          | Default                          | Description                          |
| ----------------- | -------------------------------- | ------------------------------------ |
| `PORT`            | `3001`                           | Backend HTTP port.                   |
| `PGLITE_DATA_DIR` | `server/data/pgdata`             | Where PGLite persists its data.      |
| `VITE_API_TARGET` | `http://localhost:3001`          | Backend target for the Vite proxy.   |
