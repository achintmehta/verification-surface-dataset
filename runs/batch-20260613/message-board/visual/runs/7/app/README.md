# PGLite SSE Message Board

A tiny realtime message board built with:

- Express
- Embedded PGLite persisted to local disk
- Server-Sent Events (SSE)
- Vanilla JavaScript powered by Vite

## Development

```bash
npm install
npm run dev
```

The backend runs on `http://localhost:3000` and the Vite frontend runs on `http://localhost:5173` with `/api` proxied to the backend.

## Production-style run

```bash
npm install
npm run build
npm start
```

After building, Express serves `frontend/dist` and the API from the same process.

## API

- `GET /api/messages` - returns historical messages
- `POST /api/messages` - creates a message with JSON body `{ "text": "..." }`
- `GET /api/stream` - SSE stream of newly created messages

PGLite data is stored in `./pglite-data` by default. Override with `PGLITE_DATA_DIR=/path/to/data`.
