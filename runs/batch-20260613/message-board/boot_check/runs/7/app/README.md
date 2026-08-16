# PGLite SSE Message Board

A small traditional client-server web app with realtime message updates.

- Backend: Express + embedded PGLite persisted to `./data/pglite`
- Realtime: Server-Sent Events at `GET /api/stream`
- Frontend: Vanilla JavaScript with Vite

## Scripts

```bash
npm run dev      # runs Express on :3000 and Vite on :5173
npm start        # runs the Express server and serves built/static frontend assets when available
npm run build    # builds the frontend into dist/
```

## API

- `GET /api/messages` returns historical messages.
- `POST /api/messages` accepts `{ "text": "message" }` and broadcasts the inserted message.
- `GET /api/stream` opens an SSE stream for realtime messages.
