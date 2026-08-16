# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

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
| Backend  | http://localhost:3001      |
| Health   | http://localhost:3001/api/health |

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vite dev server :5173)                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  index.html + main.js + style.css                │  │
│  │                                                  │  │
│  │  1. GET /api/messages  → load history            │  │
│  │  2. GET /api/stream    → EventSource (SSE)       │  │
│  │  3. POST /api/messages → submit new message      │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE (proxied by Vite)
┌────────────────────────▼────────────────────────────────┐
│  Express server :3001                                   │
│                                                         │
│  GET  /api/messages  → SELECT * FROM messages           │
│  POST /api/messages  → INSERT + broadcast to SSE clients│
│  GET  /api/stream    → SSE endpoint (keep-alive)        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  PGLite (embedded PostgreSQL, persisted to disk) │  │
│  │  ./data/pglite/                                  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
.
├── server/
│   ├── index.js          # Express app entry point
│   ├── db.js             # PGLite initialisation & schema
│   ├── sseClients.js     # SSE client registry & broadcast helper
│   └── routes/
│       ├── messages.js   # GET + POST /api/messages
│       └── stream.js     # GET /api/stream
├── frontend/
│   ├── index.html        # App shell
│   ├── main.js           # Vanilla JS logic
│   ├── vite.config.js    # Vite config (dev proxy → :3001)
│   └── public/
│       └── style.css     # All styles
├── data/                 # PGLite data directory (git-ignored)
└── package.json
```

## API

### `GET /api/messages`
Returns all messages ordered oldest → newest.

```json
[
  { "id": 1, "text": "Hello!", "created_at": "2024-01-01T12:00:00.000Z" }
]
```

### `POST /api/messages`
Create a new message. Body: `{ "text": "..." }` (max 2000 chars).

Returns `201` with the created message object.

### `GET /api/stream`
SSE endpoint. Emits `new-message` events:

```
event: new-message
data: {"id":2,"text":"Hi there","created_at":"2024-01-01T12:01:00.000Z"}
```
