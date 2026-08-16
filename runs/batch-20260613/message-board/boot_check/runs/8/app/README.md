# PGLite SSE Message Board

A tiny real-time message board built with Express, embedded PGLite, Server-Sent Events, and a Vanilla JS/Vite frontend.

## Scripts

- `npm start` - start the Express backend and serve the lightweight frontend.
- `npm run dev` - run the backend and Vite dev server concurrently.
- `npm run build` - build the frontend into `dist/`.

## API

- `GET /api/messages` - returns all messages in chronological order.
- `POST /api/messages` - accepts `{ "text": "..." }`, stores a message, and broadcasts it.
- `GET /api/stream` - SSE feed for new messages.

Data persists on disk in `pgdata/` by default. Set `PGLITE_DATA_DIR` to override it.
