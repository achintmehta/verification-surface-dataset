# Week Calendar

A single-user week-view calendar with a Node/Express API, embedded PGLite persistence, and a vanilla JavaScript/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- API: `http://localhost:3000`
- Frontend: `http://localhost:5173`

PGLite persists data in `./pgdata` by default. Override with `PGLITE_DATA_DIR=/path/to/data npm run server`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid payloads with empty titles or `end_at <= start_at` return HTTP 400.
