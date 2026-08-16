const fs = require('fs');
const path = require('path');
fs.rmSync(path.join(__dirname, 'pglite-data'), { recursive: true, force: true });
