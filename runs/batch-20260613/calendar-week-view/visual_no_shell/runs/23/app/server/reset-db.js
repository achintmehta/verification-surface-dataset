// This file exists just to document that pgdata should be deleted for a fresh start
// The actual deletion happens by removing the pgdata directory
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'pgdata');

try {
  fs.rmSync(DB_PATH, { recursive: true, force: true });
  console.log('Database reset: removed', DB_PATH);
} catch (e) {
  console.log('Nothing to reset');
}
