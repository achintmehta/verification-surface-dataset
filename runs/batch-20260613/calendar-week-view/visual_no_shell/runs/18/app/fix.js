const fs = require('fs');
let code = fs.readFileSync('frontend/src/main.js', 'utf8');
code = code.replace(/\\\`/g, '`');
code = code.replace(/\\\$/g, '$');
fs.writeFileSync('frontend/src/main.js', code);
