# Message Board

A real-time message board built with:

- **Backend**: Node.js + Express + [PGLite](https://pglite.dev/) (embedded PostgreSQL)
- **Real-time**: Server-Sent Events (SSE)
- **Frontend**: Vanilla JS + [Vite](https://vitejs.dev/)

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3001

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Browser                                                │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Vanilla JS SPA (Vite dev server :5173)          │  │
│  │  • Fetches history  GET  /api/messages           │  │
│  │  • Posts messages   POST /api/messages           │  │
│  │  • Listens for SSE  GET  /api/stream             │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP / SSE
┌────────────────────────▼────────────────────────────────┐
│  Node.js Server (:3001)                                 │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Express                                         │  │
│  │  • GET  /api/messages  → SELECT from PGLite      │  │
│  │  • POST /api/messages  → INSERT + broadcast SSE  │  │
│  │  • GET  /api/stream    → SSE endpoint            │  │
│  └──────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  PGLite (embedded PostgreSQL WASM)               │  │
│  │  Persists to ./data/messages.db                  │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## API

| Method | Path            | Description                        |
|--------|-----------------|------------------------------------|
| GET    | /api/messages   | Returns all messages (oldest first)|
| POST   | /api/messages   | Creates a new message              |
| GET    | /api/stream     | SSE stream for real-time updates   |

### POST /api/messages

**Request body**
```json
{ "text": "Hello, world!" }
```

**Response** `201 Created`
```json
{
  "id": 1,
  "text": "Hello, world!",
  "created_at": "2024-01-01T12:00:00.000Z"
}
```
