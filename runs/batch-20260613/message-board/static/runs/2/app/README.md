# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Vanilla JS SPA (Vite dev server :5173)          │  │
│  │                                                  │  │
│  │  GET  /api/messages  ──────────────────────────► │  │
│  │  POST /api/messages  ──────────────────────────► │  │
│  │  GET  /api/stream    (SSE) ─────────────────────►│  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                          │ proxy (dev) / direct (prod)
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Node.js Express Server (:3000)                         │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │  PGLite (embedded PostgreSQL, persists to ./data)│  │
│  │                                                  │  │
│  │  messages table:                                 │  │
│  │    id         SERIAL PRIMARY KEY                 │  │
│  │    text       TEXT NOT NULL                      │  │
│  │    created_at TIMESTAMPTZ DEFAULT NOW()          │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
message-board/
├── package.json            # Root workspace – runs both server & client
├── server/
│   ├── package.json
│   └── src/
│       ├── index.js        # Express app entry point
│       ├── db.js           # PGLite initialisation & schema
│       ├── sse.js          # SSE client registry & broadcast helper
│       └── routes/
│           ├── messages.js # GET /api/messages, POST /api/messages
│           └── stream.js   # GET /api/stream (SSE endpoint)
├── client/
│   ├── package.json
│   ├── vite.config.js      # Vite config with /api proxy
│   ├── index.html
│   └── src/
│       ├── main.js         # Vanilla JS – history load, SSE, form submit
│       └── style.css
└── data/                   # PGLite database files (auto-created, git-ignored)
```

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

This starts both servers concurrently:

| Service | URL |
|---------|-----|
| Frontend (Vite) | http://localhost:5173 |
| Backend (Express) | http://localhost:3000 |

The Vite dev server proxies all `/api/*` requests to the Express backend, so
you only need to open **http://localhost:5173** in your browser.

### Build for production

```bash
npm run build
```

The frontend is compiled into `server/public/`. You can then serve everything
from the Express server by adding a static-file middleware:

```js
app.use(express.static(path.join(__dirname, '../public')));
```

## API Reference

### `GET /api/messages`

Returns all messages in chronological order.

**Response** `200 OK`
```json
[
  {
    "id": 1,
    "text": "Hello, world!",
    "created_at": "2024-01-15T10:30:00.000Z"
  }
]
```

### `POST /api/messages`

Creates a new message and broadcasts it to all SSE clients.

**Request body**
```json
{ "text": "Hello, world!" }
```

**Response** `201 Created`
```json
{
  "id": 2,
  "text": "Hello, world!",
  "created_at": "2024-01-15T10:30:05.000Z"
}
```

### `GET /api/stream`

Opens a persistent SSE connection. The server pushes `message` events whenever
a new message is posted.

**Event format**
```
event: message
data: {"id":2,"text":"Hello, world!","created_at":"2024-01-15T10:30:05.000Z"}
```

### `GET /api/health`

Simple health-check endpoint.

**Response** `200 OK`
```json
{ "status": "ok", "timestamp": "2024-01-15T10:30:00.000Z" }
```

## Design Decisions

See the project specification for full rationale. Key choices:

- **PGLite** – embedded PostgreSQL in the Node process; no external DB needed.
- **SSE over WebSockets** – one-way push is all we need; SSE is simpler and
  works natively over HTTP/1.1.
- **Vanilla JS** – minimal UI requirements; no framework overhead.
