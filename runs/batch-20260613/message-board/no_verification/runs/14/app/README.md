# Realtime Message Board

A fast, local-first collaborative message board. Users can post text messages and
see updates from other connected clients in real time.

## Architecture

- **Backend**: Node.js + Express, with an embedded [PGLite](https://github.com/electric-sql/pglite)
  PostgreSQL database persisting to local disk. Real-time updates are pushed to clients via
  **Server-Sent Events (SSE)**.
- **Frontend**: Vanilla JS bundled with [Vite](https://vitejs.dev/). A single page with a
  message feed and a text input form.

```
.
├── server/        # Express + PGLite backend
│   └── src/
│       ├── index.js   # Express app, routes, SSE
│       └── db.js      # PGLite initialization & queries
├── client/        # Vanilla JS + Vite frontend
│   ├── index.html
│   └── src/
│       └── main.js
└── package.json   # Root scripts to run both apps together
```

## Getting Started

Install dependencies for the root, server, and client:

```bash
npm run install:all
```

Run both the backend and frontend dev servers concurrently:

```bash
npm run dev
```

- The backend listens on `http://localhost:3000`.
- The Vite dev server runs on `http://localhost:5173` and proxies `/api` requests to the backend.

Open `http://localhost:5173` in two browser tabs to see real-time updates in action.

## API

| Method | Endpoint         | Description                                            |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/api/messages`  | Fetch all historical messages (oldest first).          |
| POST   | `/api/messages`  | Post a new message. Body: `{ "text": "hello" }`.       |
| GET    | `/api/stream`    | SSE endpoint. Streams new messages to connected clients.|

## Production

Build the frontend and serve it statically from the backend:

```bash
npm run build      # builds client/dist
npm start          # starts server which also serves client/dist
```
