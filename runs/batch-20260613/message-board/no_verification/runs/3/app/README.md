# Message Board

A lightweight, real-time message board built with:

| Layer     | Technology                                      |
|-----------|-------------------------------------------------|
| Backend   | Node.js + Express                               |
| Database  | PGLite (embedded PostgreSQL, persisted to disk) |
| Real-time | Server-Sent Events (SSE)                        |
| Frontend  | Vanilla JS + Vite                               |

---

## Project Structure

```
message-board/
├── package.json              # Root workspace – runs both servers concurrently
├── backend/
│   ├── package.json
│   ├── data/                 # PGLite persists here (auto-created at runtime)
│   └── src/
│       ├── index.js          # Express server entry point
│       ├── db.js             # PGLite initialisation & schema
│       ├── sseManager.js     # SSE client registry & broadcast helper
│       └── routes/
│           ├── messages.js   # GET /api/messages  POST /api/messages
│           └── stream.js     # GET /api/stream  (SSE endpoint)
└── frontend/
    ├── package.json
    ├── vite.config.js        # Dev-server proxy → backend :3001
    ├── index.html
    └── src/
        ├── main.js           # App bootstrap & orchestration
        ├── api.js            # fetch / EventSource wrappers
        ├── ui.js             # DOM helpers (render, append, status badge)
        └── style.css
```

---

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

| Server   | URL                      |
|----------|--------------------------|
| Backend  | http://localhost:3001    |
| Frontend | http://localhost:5173    |

Open **http://localhost:5173** in your browser.  Open a second tab to see
real-time updates arrive instantly.

### Build the frontend for production

```bash
npm run build
```

The compiled assets are written to `frontend/dist/`.

---

## API Reference

### `GET /api/messages`

Returns all messages ordered oldest-first.

**Response** `200 OK`
```json
[
  { "id": 1, "text": "Hello!", "created_at": "2024-01-01T12:00:00.000Z" }
]
```

---

### `POST /api/messages`

Creates a new message and broadcasts it to all connected SSE clients.

**Request body**
```json
{ "text": "Hello, world!" }
```

**Response** `201 Created`
```json
{ "id": 2, "text": "Hello, world!", "created_at": "2024-01-01T12:01:00.000Z" }
```

---

### `GET /api/stream`

Opens a persistent SSE connection.  The server pushes `new-message` events
whenever a message is inserted.

**Event format**
```
event: new-message
data: {"id":2,"text":"Hello, world!","created_at":"2024-01-01T12:01:00.000Z"}
```

---

## Architecture Notes

- **PGLite** runs entirely inside the Node.js process.  Data is persisted to
  `backend/data/` so messages survive server restarts.
- **SSE** is used for one-way server→client push.  Clients post new messages
  via a standard HTTP `POST` request; the server then broadcasts the result to
  all active SSE connections.
- The Vite dev-server **proxies** all `/api` requests to the Express backend,
  so the frontend never needs to hard-code a backend URL.
- Duplicate-message protection: `appendMessage` checks for an existing DOM
  element with the same `data-id` before inserting, preventing the same
  message from appearing twice if both the POST response and the SSE event
  arrive for the same client.
