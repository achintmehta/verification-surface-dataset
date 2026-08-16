# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS)                                   │
│                                                         │
│  ┌──────────────┐   POST /api/messages                  │
│  │  Compose     │──────────────────────────────────────►│
│  │  Form        │                                       │
│  └──────────────┘                                       │
│                                                         │
│  ┌──────────────┐   GET /api/stream (SSE)               │
│  │  Message     │◄─────────────────────────────────────►│
│  │  Feed        │                                       │
│  └──────────────┘                                       │
└─────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────┐
│  Node.js / Express                                      │
│                                                         │
│  GET  /api/messages  – fetch history                    │
│  POST /api/messages  – insert + broadcast               │
│  GET  /api/stream    – SSE endpoint                     │
│  GET  /api/health    – health check                     │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  PGLite (embedded PostgreSQL, persisted to disk) │   │
│  │  ./data/                                         │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Getting Started

### Prerequisites

- Node.js 18+

### Install dependencies

```bash
npm install
```

### Run in development mode

Starts both the Express backend (port 3001) and the Vite dev server (port 5173) concurrently:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

> The Vite dev server proxies all `/api/*` requests to the backend, so you never need to worry about CORS during development.

### Run backend only

```bash
npm run dev:backend
```

### Run frontend only

```bash
npm run dev:frontend
```

### Build for production

```bash
npm run build
```

Outputs the compiled frontend to `./dist/`.

### Start in production mode

```bash
npm start
```

## Project Structure

```
.
├── server/
│   ├── index.js          # Express app entry point
│   ├── db.js             # PGLite initialisation & helpers
│   ├── sseClients.js     # SSE client registry & broadcast
│   └── routes/
│       ├── messages.js   # GET + POST /api/messages
│       └── stream.js     # GET /api/stream (SSE)
├── client/
│   ├── index.html        # App shell
│   ├── main.js           # Vanilla JS – history, SSE, form
│   ├── style.css         # Styles
│   └── vite.config.js    # Vite configuration
├── data/                 # PGLite database files (auto-created, git-ignored)
└── package.json
```

## API Reference

| Method | Path             | Description                                      |
|--------|------------------|--------------------------------------------------|
| GET    | `/api/messages`  | Returns all messages ordered by `created_at ASC` |
| POST   | `/api/messages`  | Creates a new message; body: `{ "text": "..." }` |
| GET    | `/api/stream`    | SSE stream; emits `new-message` events           |
| GET    | `/api/health`    | Health check                                     |

### SSE Events

| Event name    | Payload                                      |
|---------------|----------------------------------------------|
| `connected`   | `{ "status": "ok" }`                         |
| `new-message` | `{ id, text, created_at }` (same as REST)    |
