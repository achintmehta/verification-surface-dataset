# Week Calendar

Single-user week-view calendar with a Node/Express API, embedded PGLite persistence, and a vanilla JavaScript/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Frontend dev server: http://localhost:5173
- PGLite data is persisted under `data/pglite` by default.

For production-style serving:

```bash
npm run build
npm start
```

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles or non-positive durations are rejected with HTTP 400.
