# Week Calendar

Single-user week-view calendar with a Node/Express API, embedded PGLite persistence, and a vanilla JavaScript/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Backend: `http://localhost:3001`
- Frontend (Vite): shown by Vite, typically `http://localhost:5173`

For production-style serving:

```bash
npm run build
npm start
```

Events are persisted on local disk in `pglite-data/`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles and non-positive durations are rejected with HTTP 400.
