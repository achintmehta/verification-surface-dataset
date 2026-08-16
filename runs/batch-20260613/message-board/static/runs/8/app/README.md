# PGLite SSE Message Board

A lightweight traditional client-server message board using Express, embedded PGLite, Server-Sent Events, and a vanilla Vite frontend.

## Scripts

- `npm run dev` - start the backend and Vite dev server together.
- `npm run dev:server` - start only the Express/PGLite backend on port `3000`.
- `npm run dev:client` - start only the Vite frontend on port `5173` with `/api` proxied to the backend.
- `npm run build` - build the frontend into `dist/`.
- `npm start` - start the backend; if `dist/` exists, it also serves the built frontend.
- `npm run lint` - syntax-check the JavaScript source files.

## Data

PGLite persists message data in `.pglite-data/` by default. Set `PGLITE_DATA_DIR` to use a different local directory.

## API

- `GET /api/messages` returns historical messages ordered oldest-to-newest.
- `POST /api/messages` accepts `{ "text": "..." }`, stores a message, and broadcasts it.
- `GET /api/stream` opens an SSE stream that emits new message JSON objects.
