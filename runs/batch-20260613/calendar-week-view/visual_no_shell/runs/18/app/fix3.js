const fs = require('fs');
let code = fs.readFileSync('backend/server.js', 'utf8');
code = code.replace(/\\\`/g, '`');
code = code.replace(/\\\$/g, '$');
fs.writeFileSync('backend/server.js', code);
