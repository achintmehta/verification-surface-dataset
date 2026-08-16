# PGLite SSE Message Board

A small traditional client-server web application that stores messages in embedded PGLite and pushes new messages to every connected browser via Server-Sent Events (SSE).

## Features

- Express backend with JSON APIs
- Embedded PGLite database persisted under `data/pglite`
- `GET /api/messages` historical message feed
- `POST /api/messages` message creation endpoint
- `GET /api/stream` SSE endpoint for live updates
- Lightweight Vite + vanilla JavaScript frontend

## Getting started

```bash
npm install
npm run dev
```

The backend runs on <http://localhost:3000> and the Vite frontend runs on <http://localhost:5173>.

## Production-style run

```bash
npm run build
npm start
```

The Express server serves the built frontend from `dist` when `NODE_ENV=production`.

## Configuration

- `PORT` - backend port, defaults to `3000`
- `PGLITE_DATA_DIR` - PGLite persistence directory, defaults to `./data/pglite`
- `VITE_API_URL` - frontend API base URL, defaults to `http://localhost:3000`
