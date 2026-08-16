# Realtime Message Board

A lightweight, local-first collaborative message board built with an embedded
PGLite database and Server-Sent Events (SSE). The backend is a Node.js/Express
server; the frontend is a Vanilla JS app powered by Vite.

## Architecture

- **Backend** (`server/`): Express server with an embedded PGLite database
  persisted to `./pgdata`. Exposes a REST API and an SSE stream.
- **Frontend** (`index.html`, `src/`): Vanilla JS SPA served by Vite that
  fetches history, subscribes to the SSE stream, and posts new messages.

## API

| Method | Path            | Description                                        |
| ------ | --------------- | -------------------------------------------------- |
| GET    | `/api/messages` | Fetch historical messages (initial state).         |
| POST   | `/api/messages` | Insert a new message `{ "text": "..." }`.          |
| GET    | `/api/stream`   | SSE stream that pushes new messages in real time.  |

## Getting Started

Install dependencies:

```bash
npm install
```

Run the backend and frontend dev servers together:

```bash
npm run dev
```

- Frontend: http://localhost:5173 (Vite, proxies `/api` to the backend)
- Backend:  http://localhost:3000

### Production / single server

Build the frontend and run the backend:

```bash
npm run build
npm start
```

## Data Persistence

Messages are stored in a PostgreSQL-compatible database embedded via PGLite and
persisted to the `pgdata/` directory on the local disk.
