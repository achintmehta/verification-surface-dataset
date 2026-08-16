# Week Calendar

A single-user week-view calendar with a Node/Express API, embedded PGLite persistence, and a vanilla JavaScript/Vite frontend.

## Features

- Monday–Sunday week view with a continuous 00:00–24:00 axis.
- Minute-accurate absolute event positioning.
- Cluster-based overlap layout so simultaneous events divide the day-column width and never cover each other.
- Create events by clicking or dragging in an empty day column.
- Edit and delete events by clicking an event.
- Previous / Today / Next week navigation.
- Durable local persistence in `pglite-data/`.

## Run

```bash
npm install
npm run dev
```

- API: http://localhost:3000
- Frontend: http://localhost:5173

You can also run the backend alone with `npm run server` and the frontend alone with `npm run client`.

## API

- `GET /api/events?start=<iso>&end=<iso>` returns events where `start_at < end` and `end_at > start`.
- `POST /api/events` with `{ "title", "start_at", "end_at" }` creates an event.
- `PUT /api/events/:id` updates an event.
- `DELETE /api/events/:id` deletes an event.

Invalid titles or non-positive durations are rejected with HTTP 400.
