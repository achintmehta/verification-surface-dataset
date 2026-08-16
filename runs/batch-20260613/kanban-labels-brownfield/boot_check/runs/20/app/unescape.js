import fs from 'fs';
let content = fs.readFileSync('src/main.js', 'utf8');
content = content.replace(/\\\`/g, '`');
content = content.replace(/\\\$/g, '$');
fs.writeFileSync('src/main.js', content);
