# Message Board

A real-time message board built with **PGLite** (embedded PostgreSQL) and **Server-Sent Events (SSE)**.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL persisted to disk)
- **Frontend**: Vanilla TypeScript + Vite
- **Real-time**: Server-Sent Events (SSE) for one-way push from server to clients

## Getting Started

```bash
# Install all dependencies
npm run install:all

# Run both backend and frontend in development mode
npm run dev
```

- **Frontend**: http://localhost:5173
- **Backend API**: http://localhost:3000

## API Endpoints

| Method | Path             | Description                              |
| ------ | ---------------- | ---------------------------------------- |
| GET    | `/api/messages`  | Fetch the most recent 100 messages       |
| POST   | `/api/messages`  | Create a new message (`{ "text": "…" }`) |
| GET    | `/api/stream`    | SSE stream for real-time updates         |
| GET    | `/api/health`    | Health check                             |

## How It Works

1. On page load the client fetches all existing messages via `GET /api/messages`.
2. The client opens an SSE connection to `GET /api/stream`.
3. When a user submits a message, the client sends a `POST /api/messages` request.
4. The server inserts the message into PGLite and broadcasts a `newMessage` event to all SSE clients.
5. Every connected client receives the event and appends the new message to the DOM.

Duplicate messages are prevented on the client side by tracking rendered message IDs.
