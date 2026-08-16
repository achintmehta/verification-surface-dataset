// Central configuration for the seat-booking server.
export const ROWS = ['A', 'B', 'C', 'D', 'E'];
export const SEATS_PER_ROW = 10;

// Hold time-to-live in milliseconds.
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 2 * 60 * 1000);

// How often the background sweep runs to release expired holds.
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5 * 1000);

// HTTP port for the backend API.
export const PORT = Number(process.env.PORT || 3000);

// Directory PGLite persists to. Use a fresh in-memory db for tests.
export const DATA_DIR = process.env.PGLITE_DATA_DIR || './data/seats';
