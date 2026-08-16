# Realtime PGLite Message Board

A small traditional client/server web app that uses Express, embedded PGLite, and Server-Sent Events (SSE) to provide a persistent realtime message board.

## Stack

- Backend: Node.js, Express, `@electric-sql/pglite`
- Realtime: Server-Sent Events at `GET /api/stream`
- Frontend: Vite + vanilla JavaScript
- Persistence: local `.pglite/` directory

## Scripts

```bash
npm install
npm run dev      # API on :3000 and Vite UI on :5173
npm run build    # Build frontend assets
npm start        # Start API and serve built dist/ assets
```

## API

- `GET /api/messages` - returns the latest message history
- `POST /api/messages` - accepts `{ "text": "hello" }`, inserts it, and broadcasts it
- `GET /api/stream` - SSE stream for newly posted messages
