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
    main.js      – History fetch, SSE listener, form handler
    style.css    – Styles

server/          – Node.js + Express backend
  index.js       – Entry point; starts Express after DB init
  db.js          – PGLite initialisation & schema creation
  routes.js      – GET /api/messages, POST /api/messages, GET /api/stream
  sse.js         – SSE client registry & broadcast helper

data/pglite/     – PGLite persisted data (auto-created, git-ignored)
```

## API

| Method | Path              | Description                                  |
|--------|-------------------|----------------------------------------------|
| GET    | `/api/messages`   | Returns all messages (oldest first)          |
| POST   | `/api/messages`   | Creates a new message `{ text: string }`     |
| GET    | `/api/stream`     | SSE stream; emits `new-message` events       |

### SSE Event Format

```
event: new-message
data: {"id":1,"text":"Hello!","created_at":"2024-01-01T12:00:00.000Z"}
```

## Scripts

| Command             | Description                                  |
|---------------------|----------------------------------------------|
| `npm run dev`       | Start both servers concurrently              |
| `npm run dev:backend`  | Start only the Express server (port 3000) |
| `npm run dev:frontend` | Start only the Vite dev server (port 5173)|
| `npm run build`     | Build the frontend for production            |
| `npm start`         | Start the production Express server          |
