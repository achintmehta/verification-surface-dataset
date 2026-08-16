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

## Architecture

```
client/          – Vite + Vanilla JS frontend
  index.html     – App shell (message list + post form)
  src/
    main.js      – History fetch, SSE listener, form submit
    style.css    – Styles

server/          – Node.js + Express backend
  index.js       – App entry point (starts Express)
  db.js          – PGLite initialisation & helper
  routes.js      – GET /api/messages, POST /api/messages, GET /api/stream
  sse.js         – SSE client registry & broadcast helper

data/            – PGLite persisted database files (auto-created)
```

## API

| Method | Path              | Description                              |
|--------|-------------------|------------------------------------------|
| GET    | `/api/messages`   | Fetch all messages (oldest → newest)     |
| POST   | `/api/messages`   | Create a new message `{ text: string }`  |
| GET    | `/api/stream`     | SSE stream – emits `message` events      |

### SSE Event format

```
event: message
data: {"id":1,"text":"Hello!","created_at":"2024-01-01T12:00:00.000Z"}
```

## Scripts

| Command             | Description                                  |
|---------------------|----------------------------------------------|
| `npm run dev`       | Start both servers concurrently (development)|
| `npm run dev:backend`  | Start only the Express server             |
| `npm run dev:frontend` | Start only the Vite dev server            |
| `npm run build`     | Build the frontend for production            |
| `npm start`         | Start the Express server (production)        |
