const fs = require('fs');
const code = fs.readFileSync('frontend/src/main.js', 'utf8');
const lines = code.split('\n');
console.log(lines[95]);
console.log(lines[96]);
console.log(lines[97]);
