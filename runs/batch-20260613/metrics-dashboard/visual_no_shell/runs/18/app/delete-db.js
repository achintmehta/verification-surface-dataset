const fs = require('fs');
fs.rmSync(__dirname + '/backend/pglite-data2', { recursive: true, force: true });
console.log('deleted');
