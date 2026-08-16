# Week Calendar

A single-user week-view calendar with an Express + PGLite backend and a Vanilla JS/Vite frontend.

## Features

- Monday–Sunday week view with a continuous 00:00–24:00 axis.
- Minute-proportional absolute positioning for event blocks.
- Cluster-based overlap layout: overlapping events are placed side-by-side, while independent clusters reclaim full width.
- Create events by clicking or dragging in a day column; edit/delete by clicking an event.
- Events persist to local disk through embedded PGLite.

## Run

```bash
npm install
npm run dev
```

If you prefer separate terminals, run `npm run server` and `npm run client`.

The API listens on `http://localhost:3001` and Vite serves the frontend (usually `http://localhost:5173`).

## API

- `GET /api/events?start=<iso>&end=<iso>` - events overlapping the range.
- `POST /api/events` - JSON `{ "title": "...", "start_at": "YYYY-MM-DDTHH:mm:ss", "end_at": "YYYY-MM-DDTHH:mm:ss" }`.
- `PUT /api/events/:id` - same payload as POST.
- `DELETE /api/events/:id`.

Invalid title or non-positive duration returns HTTP 400 and is not persisted.
