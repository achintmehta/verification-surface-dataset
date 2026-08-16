// Central configuration for the seat-booking backend.
export const PORT = Number(process.env.PORT) || 3001;

// Where PGLite persists its data on local disk.
export const DB_DIR = process.env.DB_DIR || './server/.pgdata';

// Fixed seat map dimensions.
export const ROWS = Number(process.env.SEAT_ROWS) || 5;
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW) || 10;

// Row labels are letters: A, B, C, ...
export const ROW_LABELS = Array.from({ length: ROWS }, (_, i) =>
  String.fromCharCode('A'.charCodeAt(0) + i)
);

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60_000;

// How often the periodic sweep runs to release stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5_000;
