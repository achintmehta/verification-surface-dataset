# Realtime Message Board

A lightweight, local-first collaborative message board built with an embedded
PGLite database and Server-Sent Events (SSE). The backend is a Node.js +
Express server; the frontend is a Vanilla JS app powered by Vite.

## Architecture

- **Backend** (`server/`): Express server with an embedded PGLite database
  persisting to `data/pgdata`. Provides REST endpoints plus an SSE stream for
  realtime updates.
- **Frontend** (`index.html`, `src/`): Vanilla JS SPA that loads message
  history, listens to the SSE stream, and posts new messages.

## API

- `GET /api/messages` — fetch all historical messages.
- `POST /api/messages` — create a message: `{ "text": "hello" }`.
- `GET /api/stream` — SSE endpoint; emits each new message as it is posted.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` runs both servers concurrently:

- Backend API: http://localhost:3000
- Frontend (Vite): http://localhost:5173

The Vite dev server proxies `/api` requests to the backend.

### Production

```bash
npm run build   # build the frontend into dist/
npm start       # run the backend, which also serves dist/
```

Then open http://localhost:3000.
