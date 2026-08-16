# Message Board

A lightweight, real-time message board built with:

| Layer     | Technology                                      |
|-----------|-------------------------------------------------|
| Backend   | Node.js + Express                               |
| Database  | PGLite (embedded PostgreSQL, persisted to disk) |
| Real-time | Server-Sent Events (SSE)                        |
| Frontend  | Vanilla JS + Vite                               |

---

## Architecture

```
Browser (Vite dev / static build)
  │
  ├─ GET  /api/messages   ──► Express ──► PGLite  (fetch history)
  ├─ POST /api/messages   ──► Express ──► PGLite  (post message)
  │                                         │
  │                                    broadcast()
  │                                         │
  └─ GET  /api/stream     ◄── SSE ◄─────────┘     (live updates)
```

- **PGLite** runs embedded inside the Node process and persists its data to
  `server/data/pglite/` on the local filesystem.
- **SSE** keeps a pool of open HTTP connections. When a new message is
  inserted, `broadcast()` writes a JSON event frame to every active client.
- The **Vite dev server** proxies `/api/*` to `http://localhost:3001` so the
  frontend never needs to know the backend port.

---

## Getting Started

### Prerequisites

- Node.js ≥ 18 (for native `--watch` and ESM support)
- npm ≥ 8 (workspaces)

### Install dependencies

```bash
npm install
```

### Run in development mode

```bash
npm run dev
```

This starts both servers concurrently:

| Server   | URL                      |
|----------|--------------------------|
| Backend  | http://localhost:3001    |
| Frontend | http://localhost:5173    |

Open **http://localhost:5173** in your browser.

### Build for production

```bash
npm run build          # builds the Vite frontend into client/dist/
npm run start          # starts only the Express server
```

In production, serve the `client/dist/` directory as static files from
Express (or a CDN) and point the frontend's API calls at the Express server.

---

## Project Structure

```
.
├── package.json              # Root workspace manifest + concurrently script
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.js          # Express app entry point
│   │   ├── db.js             # PGLite initialisation & schema
│   │   ├── sse.js            # SSE client pool & broadcast helper
│   │   └── routes/
│   │       └── messages.js   # GET /api/messages, POST /api/messages
│   └── data/
│       └── pglite/           # PGLite persisted data (git-ignored)
└── client/
    ├── package.json
    ├── vite.config.js        # Vite config with /api proxy
    ├── index.html
    └── src/
        ├── main.js           # Vanilla JS: history fetch, SSE, form submit
        └── style.css         # Minimal, responsive styles
```

---

## API Reference

### `GET /api/health`
Returns `{ status: "ok", timestamp: "…" }`.

### `GET /api/messages`
Returns all messages ordered oldest-first.

```json
[
  { "id": 1, "text": "Hello!", "created_at": "2024-01-01T12:00:00.000Z" }
]
```

### `POST /api/messages`
Creates a new message and broadcasts it to all SSE clients.

**Request body:**
```json
{ "text": "Hello, world!" }
```

**Response (201):**
```json
{ "id": 2, "text": "Hello, world!", "created_at": "2024-01-01T12:00:01.000Z" }
```

### `GET /api/stream`
Opens an SSE stream. Events:

| Event name  | Payload                                      |
|-------------|----------------------------------------------|
| `connected` | `{ "clientId": "1" }`                        |
| `message`   | `{ "id": 2, "text": "…", "created_at": "…"}` |

A `: heartbeat` comment is sent every 25 seconds to keep the connection alive.
