# PGLite SSE Message Board

A simple realtime message board built with Express, embedded PGLite, Server-Sent Events (SSE), and a lightweight Vanilla JS/Vite frontend.

## Development

Install dependencies:

```bash
npm install
```

Run the backend and frontend dev servers together:

```bash
npm run dev
```

- Backend API: `http://localhost:3000`
- Frontend: `http://localhost:5173`

Messages are persisted locally in `./data/pglite`.

## API

- `GET /api/messages` - fetch historical messages
- `POST /api/messages` - create a message with JSON body `{ "text": "hello" }`
- `GET /api/stream` - SSE stream for realtime broadcasts
