const { execSync } = require('child_process');
console.log(execSync('node backend/test.js').toString());
