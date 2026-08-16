# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + Vite

## Quick Start

```bash
# Install all dependencies
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
browser
  │
  ├─ GET  /api/messages   → fetch history on load
  ├─ POST /api/messages   → submit a new message
  └─ GET  /api/stream     → SSE stream for live updates
         │
         ▼
   Express server (port 3000)
         │
         ▼
   PGLite (embedded PostgreSQL, persisted to ./data/pglite/)
```

### How real-time works

1. Every browser tab opens a persistent SSE connection to `GET /api/stream`.
2. When any client posts a message via `POST /api/messages`, the server inserts
   it into PGLite and immediately broadcasts it to **all** open SSE connections.
3. Each browser tab receives the `message` event and appends the new message to
   the DOM without a page reload.

## Project Structure

```
├── server/
│   ├── index.js          # Express app entry point
│   ├── db.js             # PGLite initialisation & helpers
│   ├── sseClients.js     # SSE client registry & broadcast
│   └── routes/
│       ├── messages.js   # GET + POST /api/messages
│       └── stream.js     # GET /api/stream
├── frontend/
│   ├── index.html        # App shell
│   ├── vite.config.js    # Vite config with /api proxy
│   └── public/
│       ├── style.css     # All styles
│       └── main.js       # Vanilla JS app logic
└── data/
    └── pglite/           # PGLite persisted data (auto-created)
```

## Scripts

| Command             | Description                                  |
|---------------------|----------------------------------------------|
| `npm run dev`       | Start both servers concurrently              |
| `npm run dev:backend`  | Start only the Express server (port 3000) |
| `npm run dev:frontend` | Start only the Vite dev server (port 5173)|
| `npm run build`     | Build the frontend for production            |
| `npm start`         | Start the Express server (production)        |
