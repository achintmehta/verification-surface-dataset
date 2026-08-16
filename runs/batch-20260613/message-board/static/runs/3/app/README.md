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
│  │  Compose     │──────────────────────────────────┐    │
│  │  Form        │                                  │    │
│  └──────────────┘                                  ▼    │
│                                          ┌──────────────┤
│  ┌──────────────┐   GET /api/stream      │  Express     │
│  │  Message     │◄── SSE broadcast ──────│  Server      │
│  │  Feed        │                        │  (Node.js)   │
│  └──────────────┘   GET /api/messages    │              │
│                  ──────────────────────► │  PGLite      │
│                                          │  (embedded   │
│                                          │   Postgres)  │
└──────────────────────────────────────────┴──────────────┘
```

## Getting Started

### Prerequisites

- Node.js ≥ 18

### Install dependencies

```bash
npm install
```

### Run in development mode

Starts both the Express backend (port **3001**) and the Vite dev server (port **5173**) concurrently:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

### Run backend only

```bash
npm run dev:backend
```

### Run frontend only

```bash
npm run dev:frontend
```

### Production build

```bash
npm run build   # Builds the frontend into dist/
npm start       # Starts the Express server (serves API only; serve dist/ separately)
```

## Project Structure

```
.
├── server/
│   ├── index.js          # Express app entry point
│   ├── db.js             # PGLite initialisation & schema migration
│   ├── sseClients.js     # SSE connection pool & broadcast helper
│   └── routes/
│       ├── messages.js   # GET /api/messages, POST /api/messages
│       └── stream.js     # GET /api/stream (SSE endpoint)
├── client/
│   ├── index.html        # App shell
│   ├── main.js           # Frontend logic (history, SSE, form)
│   ├── public/
│   │   └── style.css     # Global styles
│   └── vite.config.js    # Vite configuration
├── data/                 # PGLite persisted data (auto-created, git-ignored)
└── package.json
```

## API Reference

| Method | Path            | Description                                      |
|--------|-----------------|--------------------------------------------------|
| GET    | /api/health     | Health check                                     |
| GET    | /api/messages   | Fetch all messages (oldest first)                |
| POST   | /api/messages   | Post a new message `{ text: string }`            |
| GET    | /api/stream     | SSE stream – emits `message` events in real-time |

### SSE Events

| Event       | Payload                                      | Description                        |
|-------------|----------------------------------------------|------------------------------------|
| `connected` | `{}`                                         | Fired once on successful handshake |
| `message`   | `{ id, text, created_at }`                   | Fired when a new message is posted |
