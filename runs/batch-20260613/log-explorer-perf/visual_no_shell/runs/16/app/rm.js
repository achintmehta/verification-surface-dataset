import fs from 'fs';
fs.rmSync('client/node_modules', { recursive: true, force: true });
fs.rmSync('client/package-lock.json', { force: true });
