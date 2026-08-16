# PGLite SSE Message Board

A lightweight realtime message board built with Express, embedded PGLite, Server-Sent Events, and a vanilla Vite frontend.

## Scripts

```bash
npm install
npm run dev       # backend on :3000 and Vite frontend on :5173
npm run build     # build frontend into dist/
npm start         # run backend and serve dist/ in production
```

PGLite persists data in `.pgdata/` by default. Override with `PGLITE_DATA_DIR=/path/to/data`.

## API

- `GET /api/messages` - returns historical messages.
- `POST /api/messages` - accepts `{ "text": "hello" }`, stores a message, broadcasts it to connected clients.
- `GET /api/stream` - SSE stream emitting `message` events for newly posted messages.
