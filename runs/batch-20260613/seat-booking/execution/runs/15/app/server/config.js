export const PORT = process.env.PORT || 3001;

// Seat map dimensions
export const ROWS = 5;          // A..E
export const SEATS_PER_ROW = 10;

// Hold time-to-live in milliseconds
export const HOLD_TTL_MS = Number(process.env.HOLD_TTL_MS || 60_000);

// How often the background sweep releases expired holds
export const SWEEP_INTERVAL_MS = Number(process.env.SWEEP_INTERVAL_MS || 5_000);

// Where PGLite persists its data on disk
export const DB_DIR = process.env.DB_DIR || './server/.pgdata';
