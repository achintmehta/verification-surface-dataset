# PGLite SSE Message Board

A small traditional client-server realtime message board. The backend is an Express server with an embedded PGLite database persisted to local disk. The frontend is a lightweight Vanilla JS app powered by Vite. New messages are pushed to all connected clients with Server-Sent Events (SSE).

## Scripts

```bash
npm install
npm run dev
```

- API server: <http://localhost:3000>
- Vite frontend: <http://localhost:5173>

## API

- `GET /api/messages` - returns recent message history.
- `POST /api/messages` - accepts `{ "text": "message" }` and broadcasts the inserted row.
- `GET /api/stream` - SSE endpoint for realtime updates.

## Persistence

By default, PGLite data is stored in `./data/pglite`. Override with `DATABASE_PATH=/some/path npm start`.

## Configuration

- `PORT` - backend port, defaults to `3000`.
- `CLIENT_ORIGIN` - CORS origin, defaults to `http://localhost:5173`.
- `DATABASE_PATH` - local PGLite storage path.
- `VITE_API_BASE_URL` - frontend API base URL, defaults to `http://localhost:3000`.
