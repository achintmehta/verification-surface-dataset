# PGLite SSE Message Board

A tiny real-time message board built with Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Development

```bash
npm install
npm run dev
```

- Backend: http://localhost:3000
- Frontend: http://localhost:5173

The Vite dev server proxies `/api` requests to the backend.

## Production-style run

```bash
npm install
npm run build
npm start
```

The Express server serves the built frontend from `client/dist` and exposes the API on the same origin.

## Data persistence

PGLite stores data on local disk in `./data/pglite` by default. Override with:

```bash
DATABASE_PATH=/path/to/db npm start
```
