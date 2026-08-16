const { execSync } = require('child_process');
console.log(execSync('node test-pglite.js').toString());