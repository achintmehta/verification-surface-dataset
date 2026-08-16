// Central configuration for the seat-booking service.
export const PORT = Number(process.env.PORT) || 3001;

// Path on local disk where PGLite persists its data.
export const DB_DIR = process.env.DB_DIR || './pgdata';

// Seat map dimensions.
export const ROWS = Number(process.env.ROWS) || 5;
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW) || 10;

// Row labels A, B, C, ...
export const ROW_LABELS = Array.from({ length: ROWS }, (_, i) =>
  String.fromCharCode(65 + i)
);

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60 * 1000;

// How often the background sweep runs to release stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5 * 1000;
