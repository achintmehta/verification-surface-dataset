# Week Calendar

A single-user client/server week-view calendar with minute-accurate event geometry, CRUD forms, and durable local persistence through embedded PGLite.

## Run

```bash
npm install
npm run dev
```

- API server: `http://localhost:3000`
- Vite frontend: `http://localhost:5173`

PGLite data is persisted under `data/pglite`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles and non-positive durations are rejected with HTTP 400.
