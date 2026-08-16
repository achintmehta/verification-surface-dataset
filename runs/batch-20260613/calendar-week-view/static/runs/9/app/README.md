# Week Calendar

Single-user week-view calendar with a Node/Express JSON API, PGLite persistence, and a vanilla JS/Vite frontend.

## Scripts

- `npm run server` starts the API on `http://localhost:3000`.
- `npm run client` starts Vite for the frontend.
- `npm run dev` starts both development servers.

PGLite data is stored under `data/pglite` by default. Override with `PGLITE_DATA_DIR=/path/to/db`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles or time ranges are rejected with HTTP 400.
