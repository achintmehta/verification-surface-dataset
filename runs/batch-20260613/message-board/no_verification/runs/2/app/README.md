# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Getting Started

### Prerequisites

- Node.js ≥ 18

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

This starts two processes concurrently:

| Process | URL |
|---------|-----|
| Express backend | <http://localhost:3001> |
| Vite dev server | <http://localhost:5173> |

Open <http://localhost:5173> in your browser.

### Production build

```bash
npm run build   # Builds the frontend into dist/
npm start       # Starts only the Express server on port 3001
```

In production, serve the `dist/` directory as static files from Express (or a CDN) and point the frontend at the backend URL.

## Project Structure

```
.
├── server/
│   ├── index.js          # Express app entry point
│   ├── db.js             # PGLite initialisation & helpers
│   ├── sseClients.js     # SSE client registry & broadcast helper
│   └── routes/
│       ├── messages.js   # GET /api/messages, POST /api/messages
│       └── stream.js     # GET /api/stream  (SSE endpoint)
├── client/
│   ├── index.html        # App shell
│   ├── main.js           # Vanilla JS – history load, SSE, form submit
│   ├── style.css         # All styles
│   └── vite.config.js    # Vite configuration (proxy → backend)
├── data/                 # PGLite persisted data (auto-created, git-ignored)
└── package.json
```

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/health` | Health check |
| `GET`  | `/api/messages` | Fetch all messages (oldest first) |
| `POST` | `/api/messages` | Create a new message `{ text: string }` |
| `GET`  | `/api/stream` | SSE stream – emits `new-message` events |

### SSE Events

| Event | Payload | Description |
|-------|---------|-------------|
| `connected` | `{}` | Fired once when the stream is established |
| `new-message` | `{ id, text, created_at }` | Fired whenever a new message is inserted |
