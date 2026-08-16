# PGLite SSE Message Board

A tiny traditional client-server message board built with Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Development

```bash
npm install
npm run dev
```

- API server: http://localhost:3000
- Vite frontend: http://localhost:5173

The Vite dev server proxies `/api` requests to the Express backend.

## Production-style run

```bash
npm install
npm run build
npm start
```

The Express server serves the built frontend from `dist/` when it exists.

## Data persistence

PGLite persists Postgres data under `data/pglite` by default. Override it with:

```bash
PGLITE_DATA_DIR=/path/to/db npm start
```

## API

- `GET /api/messages` - returns all historical messages in creation order.
- `POST /api/messages` - accepts `{ "text": "..." }`, inserts a message, and broadcasts it.
- `GET /api/stream` - opens an SSE stream and receives `message` events for new posts.
