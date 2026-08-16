# PGLite SSE Message Board

A lightweight real-time message board built with Express, embedded PGLite, Server-Sent Events, and a vanilla Vite frontend.

## Scripts

- `npm run dev` - run the Express API and Vite frontend together.
- `npm run dev:server` - run only the API server on port `3000`.
- `npm run dev:client` - run only the Vite dev server on port `5173`.
- `npm run build` - build the frontend to `dist/`.
- `npm start` - run the production server and serve `dist/` if present.

## Data

PGLite persists its database files to `./data/pglite` by default. Override with `PGLITE_DATA_DIR=/path/to/db`.

## API

- `GET /api/messages` - returns historical messages.
- `POST /api/messages` with `{ "text": "..." }` - stores and broadcasts a new message.
- `GET /api/stream` - SSE stream for live messages.
