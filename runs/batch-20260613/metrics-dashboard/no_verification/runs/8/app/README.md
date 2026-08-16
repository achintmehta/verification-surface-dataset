# Metrics Dashboard

A small Node/Express + PGLite metrics API and Vanilla JS/Vite responsive dashboard.

## Run

```bash
npm install
npm run dev
```

The API listens on `http://localhost:3000`; Vite serves the dashboard on its printed dev URL (usually `http://localhost:5173`).

## API

- `GET /api/summary`
- `GET /api/timeseries`
- `GET /api/categories`
- `GET /api/recent`
- `GET /api/settings`
- `PUT /api/settings` with `{ "theme": "light" | "dark" }`

PGLite data is persisted in `./.pglite-data` and seeded deterministically on first boot.
