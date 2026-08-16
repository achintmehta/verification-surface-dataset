import fs from 'fs';
let code = fs.readFileSync('server/index.js', 'utf8');
code = code.replace(/}\n}\n\nasync function getBoard/, '}\n\nasync function getBoard');
fs.writeFileSync('server/index.js', code);
