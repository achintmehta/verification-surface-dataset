# PGLite SSE Message Board

A small traditional client-server realtime message board built with:

- Node.js + Express
- Embedded PGLite persisted to local disk
- Server-Sent Events (SSE) for realtime updates
- Vanilla JavaScript + Vite frontend

## Development

```bash
npm install
npm run dev
```

The Vite frontend runs on `http://localhost:5173` and proxies `/api` requests to the Express server on `http://localhost:3000`.

## Production-style run

```bash
npm install
npm run build
npm run server
```

The Express server serves the built frontend from `dist/` when it exists.

## API

- `GET /api/messages` - returns historical messages in chronological order.
- `POST /api/messages` - accepts `{ "text": "..." }`, stores a message, and broadcasts it.
- `GET /api/stream` - opens an SSE stream that emits `message` events for new messages.

PGLite data is stored in `server/data/pglite/`.
