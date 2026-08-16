# PGLite SSE Message Board

A lightweight traditional client-server message board built with Express, embedded PGLite, Server-Sent Events, and a vanilla Vite frontend.

## Scripts

- `npm run dev` - run the Express API and Vite frontend together.
- `npm run dev:server` - run only the backend on port `3000`.
- `npm run dev:client` - run only the frontend on port `5173` with `/api` proxied to the backend.
- `npm run build` - build the frontend into `dist/`.
- `npm start` - serve the production build and API from Express.

## Data

PGLite persists data under `data/pglite/` by default. Set `PGLITE_DATA_DIR` to override the location.
