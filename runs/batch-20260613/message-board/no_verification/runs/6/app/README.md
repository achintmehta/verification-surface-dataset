# PGLite SSE Message Board

A small traditional client-server message board that stores messages in an embedded PGLite database and broadcasts new posts to every connected browser using Server-Sent Events (SSE).

## Development

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3000
- Frontend dev server: http://localhost:5173

## Production-style run

```bash
npm install
npm run build
npm start
```

Then open http://localhost:3000.

## API

- `GET /api/messages` - fetch message history
- `POST /api/messages` - create a message with JSON body `{ "text": "..." }`
- `GET /api/stream` - SSE stream of newly-created messages
