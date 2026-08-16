# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://github.com/electric-sql/pglite) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Quick Start

```bash
# Install dependencies
npm install

# Run backend + frontend dev servers concurrently
npm run dev
```

| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:5173      |
| Backend  | http://localhost:3000      |
| Health   | http://localhost:3000/api/health |

## Architecture

```
client/          Vite-powered Vanilla JS SPA
  index.html     Shell HTML with message list + compose form
  main.js        Fetches history, opens SSE stream, handles form POST
  style.css      Lightweight CSS (no framework)
  vite.config.js Proxies /api/* to the Express backend in dev

server/          Node.js Express backend
  index.js       Entry point – wires up Express, starts listening
  db.js          PGLite initialisation (persists to ./data/pglite/)
  sse.js         SSE client registry + broadcast helper
  routes/
    messages.js  GET /api/messages  – fetch history
                 POST /api/messages – insert & broadcast
    stream.js    GET /api/stream    – SSE endpoint

data/            Created at runtime – PGLite database files (git-ignored)
```

## Scripts

| Command             | Description                                  |
|---------------------|----------------------------------------------|
| `npm run dev`       | Start backend + frontend in watch mode       |
| `npm run dev:backend`  | Backend only (Node --watch)               |
| `npm run dev:frontend` | Frontend only (Vite dev server)           |
| `npm run build`     | Build the frontend for production            |
| `npm start`         | Start the backend in production mode         |
