# Week Calendar

A single-user client/server week-view calendar with durable local persistence through embedded PGLite.

## Run

```bash
npm install
npm run dev
```

- Backend API: http://localhost:3000
- Vite frontend: http://localhost:5173

For production-style serving:

```bash
npm run build
npm start
```

Events are stored in `./pglite-data` by default. Override with `PGLITE_DATA_DIR=/path/to/data`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the half-open range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles and non-positive event durations return HTTP 400.
