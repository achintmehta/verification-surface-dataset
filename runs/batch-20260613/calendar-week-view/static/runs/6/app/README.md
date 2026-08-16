# Week Calendar

Single-user week-view calendar with a Node/Express JSON API, embedded PGLite persistence, and a Vanilla JS/Vite frontend.

## Run

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- Backend API: http://localhost:3000
- PGLite data is persisted in `.pglite-data/` by default.

## Scripts

- `npm run dev` runs backend and frontend development servers together.
- `npm run dev:server` runs only the Express/PGLite server.
- `npm run dev:client` runs only Vite.
- `npm start` runs the server and serves `dist/` if a production frontend build exists.
- `npm run lint` performs JavaScript syntax checks.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events overlapping the range.
- `POST /api/events` with `{ title, start_at, end_at }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid event payloads, including empty titles or `end_at <= start_at`, return HTTP 400.
