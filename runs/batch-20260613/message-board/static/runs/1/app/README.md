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
│  │ Compose Form │──────────────────────────────────┐    │
│  └──────────────┘                                  │    │
│                                                    ▼    │
│  ┌──────────────┐   GET /api/stream (SSE)   ┌──────────┐│
│  │ Message Feed │◄──────────────────────────│  Express ││
│  └──────────────┘                           │  Server  ││
│                                             └────┬─────┘│
│  ┌──────────────┐   GET /api/messages             │      │
│  │ Initial Load │◄────────────────────────────────┘      │
│  └──────────────┘                                        │
└─────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  PGLite (WASM)  │
                    │  ./data/pgdata  │
                    └─────────────────┘
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

> The Vite dev server proxies `/api/*` requests to `http://localhost:3001`, so there are no CORS issues during development.

### Build for production

```bash
npm run build
```

The compiled frontend assets are written to `./dist/`.

### Run in production

```bash
npm start
```

Serves the Express API on port 3001. Point a reverse proxy (e.g. nginx) at it and serve the `./dist/` folder as static files, or extend `server/index.js` to serve the built assets directly.

## Project Structure

```
.
├── server/
│   ├── index.js          # Express entry point
│   ├── db.js             # PGLite initialisation & schema
│   ├── sseClients.js     # SSE client registry & broadcast helper
│   └── routes/
│       ├── messages.js   # GET /api/messages, POST /api/messages
│       └── stream.js     # GET /api/stream (SSE)
├── frontend/
│   ├── index.html        # App shell
│   ├── main.js           # Vanilla JS application logic
│   ├── style.css         # Styles
│   └── vite.config.js    # Vite configuration
├── data/                 # PGLite persisted data (git-ignored)
└── package.json
```

## API Reference

| Method | Path            | Description                                      |
|--------|-----------------|--------------------------------------------------|
| GET    | /api/messages   | Returns all messages ordered by `created_at ASC` |
| POST   | /api/messages   | Creates a new message; body: `{ "text": "..." }` |
| GET    | /api/stream     | SSE stream; emits `new-message` events           |
| GET    | /health         | Health check                                     |

### SSE Events

| Event name    | Payload                                      |
|---------------|----------------------------------------------|
| `connected`   | `{ "status": "ok" }`                         |
| `new-message` | `{ id, text, created_at }` (ISO 8601 string) |
