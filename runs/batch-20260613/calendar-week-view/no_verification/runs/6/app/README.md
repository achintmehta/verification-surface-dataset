# Week Calendar

A single-user week-view calendar with a Node/Express API, embedded PGLite persistence, and a vanilla JavaScript/Vite frontend.

## Features

- Monday–Sunday week view with a continuous 00:00–24:00 axis.
- Minute-exact event top/height geometry using absolute positioning.
- Cluster-based overlap layout: overlapping events are assigned side-by-side columns and never cover one another.
- Create events by dragging or clicking an empty time range.
- Edit/delete events via the event dialog.
- Previous / Today / Next week navigation.
- JSON CRUD API backed by PGLite persisted in `.pglite/`.

## Scripts

```bash
npm install
npm run dev      # starts API on :3000 and Vite on :5173
npm run build    # builds frontend to dist/
npm start        # starts the API, serving dist/ too when present
```

The Vite dev server proxies `/api` to `http://localhost:3000`.

## API

- `GET /api/events?start=<iso>&end=<iso>`: events overlapping the range.
- `POST /api/events`: `{ "title": "...", "start_at": "YYYY-MM-DDTHH:mm", "end_at": "YYYY-MM-DDTHH:mm" }`.
- `PUT /api/events/:id`: same body as POST.
- `DELETE /api/events/:id`.

Invalid titles or non-positive durations return HTTP 400.
