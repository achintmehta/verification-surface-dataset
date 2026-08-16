const fs = require('fs');
const content = fs.readFileSync('frontend/src/main.js', 'utf8');
console.log(content.length);
console.log(content.split('\n').length);
