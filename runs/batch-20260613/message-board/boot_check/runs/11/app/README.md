# Realtime Message Board

A lightweight, local-first message board built with an embedded
[PGLite](https://github.com/electric-sql/pglite) PostgreSQL database and
real-time updates via **Server-Sent Events (SSE)**.

## Stack

- **Backend:** Node.js + Express + `@electric-sql/pglite` (embedded Postgres, persisted to disk)
- **Realtime:** Server-Sent Events (`GET /api/stream`)
- **Frontend:** Vanilla JS + Vite

## Getting Started

```bash
npm install

# Run backend (:3001) and frontend (:5173) together
npm run dev
```

Then open http://localhost:5173.

### Run pieces individually

```bash
npm run server   # Express + PGLite on :3001
npm run client   # Vite dev server on :5173
```

### Production build

```bash
npm run build    # outputs static frontend to ./dist
npm run start    # runs the backend server
```

## API

| Method | Path            | Description                                   |
| ------ | --------------- | --------------------------------------------- |
| GET    | `/api/messages` | Fetch all historical messages (initial state) |
| POST   | `/api/messages` | Create a new message `{ "text": "..." }`       |
| GET    | `/api/stream`   | SSE stream of new messages (`message` events)  |

## Data Persistence

PGLite writes to `./data/pgdata`. Delete that directory to reset the board.
