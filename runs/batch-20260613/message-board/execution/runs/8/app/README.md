# PGLite SSE Message Board

A lightweight realtime message board built with:

- Node.js + Express for the backend
- Embedded PGLite for persistent PostgreSQL-compatible storage on local disk
- Server-Sent Events (SSE) for realtime one-way updates to connected clients
- Vanilla JavaScript + Vite for the frontend

## Getting started

```bash
npm install
npm run dev
```

The Vite frontend runs at `http://localhost:5173` and proxies `/api` requests to the backend at `http://localhost:3000`.

For a production-style run:

```bash
npm run build
npm start
```

The Express server serves the built frontend from `dist/` and exposes the API on `http://localhost:3000`.

## API

- `GET /api/messages` - returns recent messages in chronological order.
- `POST /api/messages` - accepts JSON `{ "text": "..." }`, stores the message, and broadcasts it to stream clients.
- `GET /api/stream` - SSE stream that emits each newly-created message.

## Persistence

PGLite data is stored in the local `.pglite/` directory, which is ignored by git.
