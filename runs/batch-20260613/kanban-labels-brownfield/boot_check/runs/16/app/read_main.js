import fs from 'fs';
const content = fs.readFileSync('src/main.js', 'utf8');
console.log(content.slice(2000, 4000));
console.log('---CHUNK 2---');
console.log(content.slice(4000, 6000));
