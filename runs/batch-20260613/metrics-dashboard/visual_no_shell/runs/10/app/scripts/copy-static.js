import fs from 'fs';
import path from 'path';

const root = process.cwd();
const dist = path.join(root, 'dist');
if (fs.existsSync(dist)) process.exit(0);
fs.mkdirSync(dist, { recursive: true });
