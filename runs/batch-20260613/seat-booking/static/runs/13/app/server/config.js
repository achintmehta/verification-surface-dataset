// Central configuration for the seat-booking server.

export const PORT = Number(process.env.PORT) || 3001;

// Where PGLite persists its data on local disk.
export const DATA_DIR = process.env.PGLITE_DIR || './data/pgdata';

// Fixed seat map dimensions.
export const ROWS = Number(process.env.SEAT_ROWS) || 5;
export const SEATS_PER_ROW = Number(process.env.SEATS_PER_ROW) || 10;

// Row labels A, B, C, ... derived from ROWS.
export const ROW_LABELS = Array.from({ length: ROWS }, (_, i) =>
  String.fromCharCode('A'.charCodeAt(0) + i),
);

// How long (ms) a hold remains valid before it auto-expires.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS) || 60_000;

// How often (ms) the lazy sweep runs to release stale holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS) || 5_000;
