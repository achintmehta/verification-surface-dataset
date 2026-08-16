import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the server package root (one level up from src/).
const serverRoot = path.resolve(__dirname, '..');

export const config = {
  // Port the Express server listens on.
  port: Number(process.env.PORT) || 3001,

  // Directory on the local filesystem where PGLite persists its data.
  // Can be overridden with the DATA_DIR environment variable.
  dataDir: process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.join(serverRoot, 'data', 'pgdata'),

  // CORS origin allowed to talk to the API. During development the Vite dev
  // server runs on a different port, so we allow all origins by default.
  corsOrigin: process.env.CORS_ORIGIN || '*',
};
