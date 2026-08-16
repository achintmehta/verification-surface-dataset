# Calendar Week View

A single-user week-view calendar with minute-precision event placement, overlap layout, and persistent storage via PGLite.

## Architecture

- **Backend**: Node.js + Express + PGLite (embedded PostgreSQL, persists to `./data/pglite/`)
- **Frontend**: Vanilla JS + Vite, served on port 5173 with API proxy to port 3001

## Getting Started

```bash
npm install
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001/api/events

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Run both backend and frontend dev servers concurrently |
| `npm run dev:server` | Run only the backend (port 3001) |
| `npm run dev:client` | Run only the Vite frontend (port 5173) |
| `npm start` | Run the backend in production mode |
| `npm run build` | Build the frontend for production |

## API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/events?start=<iso>&end=<iso>` | Fetch events overlapping the range |
| `POST` | `/api/events` | Create an event `{ title, start_at, end_at }` |
| `PUT` | `/api/events/:id` | Update an event |
| `DELETE` | `/api/events/:id` | Delete an event |

## Overlap Layout Algorithm

Events within a day are grouped into **clusters** (maximal sets of transitively overlapping events) using a sweep-line algorithm. Within each cluster, events are assigned to columns greedily by start time. Each event's width is `dayColumnWidth / colCount` and its horizontal offset is `colIndex / colCount * 100%`.

This guarantees:
- No two events ever visually overlap
- N identical events render as N equal-width side-by-side blocks
- Non-overlapping events always use the full column width
