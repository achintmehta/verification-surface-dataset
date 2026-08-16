# Collaborative Kanban Board

A lightweight multi-user Kanban board built with Node.js, Express, embedded PGLite, Server-Sent Events, and a vanilla JavaScript/Vite frontend.

## Run

```bash
npm install
npm run dev
```

The API server runs on `http://localhost:3000` and the Vite frontend runs on `http://localhost:5173`.

## Features

- Ordered columns and cards persisted in local PGLite storage.
- Create cards in any column.
- Drag cards within and across columns.
- Server-authoritative fractional ordering.
- Real-time convergence using SSE broadcasts.
