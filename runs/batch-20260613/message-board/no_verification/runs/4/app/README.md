# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
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
┌─────────────────────────────────────────────────────────┐
│  Browser (Vite dev server :5173)                        │
│                                                         │
│  ┌──────────────────────────────────────────────────┐   │
│  │  main.js                                         │   │
│  │  ├─ GET  /api/messages  → load history           │   │
│  │  ├─ POST /api/messages  → send new message       │   │
│  │  └─ GET  /api/stream    → EventSource (SSE)      │   │
│  └──────────────────────────────────────────────────┘   │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE  (proxied by Vite)
┌────────────────────────▼────────────────────────────────┐
│  Express server :3000                                   │
│                                                         │
│  ┌──────────────┐   ┌──────────────┐  ┌─────────────┐  │
│  │ GET /messages│   │POST /messages│  │ GET /stream │  │
│  └──────┬───────┘   └──────┬───────┘  └──────┬──────┘  │
│         │                  │                  │         │
│         │           ┌──────▼───────┐          │         │
│         │           │ sseManager   │◄─────────┘         │
│         │           │ broadcast()  │                    │
│         │           └──────────────┘                    │
│         │                                               │
│  ┌──────▼───────────────────────────────────────────┐   │
│  │  PGLite (embedded PostgreSQL, persisted to disk) │   │
│  │  ./data/pglite/                                  │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## API

| Method | Path            | Description                          |
|--------|-----------------|--------------------------------------|
| GET    | /api/health     | Health check                         |
| GET    | /api/messages   | Fetch all messages (oldest first)    |
| POST   | /api/messages   | Post a new message `{ text: string }`|
| GET    | /api/stream     | SSE stream of `new-message` events   |

### SSE Events

| Event         | Payload                                      |
|---------------|----------------------------------------------|
| `connected`   | `{ "status": "ok" }`                         |
| `new-message` | `{ id, text, created_at }` (ISO timestamp)   |

## Data Persistence

PGLite writes its data files to `./data/pglite/`. This directory is
created automatically on first run and is excluded from version control
via `.gitignore`.

## Production Build

```bash
npm run build   # outputs static files to ./dist/
npm start       # runs the Express server only (serve ./dist/ separately)
```
