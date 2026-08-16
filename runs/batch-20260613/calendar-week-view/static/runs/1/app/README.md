# Week Calendar

A single-user week-view calendar with minute-precision event placement, overlap layout, and PGLite persistence.

## Architecture

```
calendar-week-view/
├── package.json          # Root: deps + npm scripts
├── server/
│   └── index.js          # Express + PGLite API server (port 3001)
├── client/
│   ├── index.html
│   ├── vite.config.js    # Vite dev server (port 5173) + /api proxy
│   └── src/
│       ├── main.js       # App entry point, navigation, state
│       ├── calendar.js   # Week grid renderer + drag-to-create
│       ├── layout.js     # Cluster overlap layout engine
│       ├── modal.js      # Create/edit event dialog
│       ├── api.js        # Fetch wrappers for the JSON API
│       ├── week.js       # Week navigation utilities
│       └── style.css     # All styles
└── data/
    └── pglite/           # PGLite database files (auto-created)
```

## Getting Started

```bash
npm install
npm run dev        # starts both server (3001) and client (5173)
```

Open http://localhost:5173 in your browser.

## API

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/events?start=<iso>&end=<iso>` | Events overlapping the range |
| POST | `/api/events` | Create event `{title, start_at, end_at}` |
| PUT | `/api/events/:id` | Update event |
| DELETE | `/api/events/:id` | Delete event |

All timestamps are ISO 8601 UTC strings. Invalid requests return HTTP 400.

## Layout Algorithm

Events within a day are grouped into **clusters** (maximal sets of transitively overlapping events). Within each cluster, events are assigned to **lanes** greedily by start time: each event goes into the first lane whose last event has already ended. The cluster's day-column width is divided equally among its lanes.

This guarantees:
- No two event blocks ever overlap visually.
- N events with identical time ranges render as N equal-width side-by-side blocks.
- Events that don't overlap use the full column width.
- Partially overlapping chains are handled correctly.

## Geometry

- `--hour-height: 64px` — one hour row height (single source of truth)
- Event `top = (startMinutes / 1440) × 1536px`
- Event `height = (durationMinutes / 1440) × 1536px`
- Events ending at 24:00 terminate exactly at the column's bottom edge.
