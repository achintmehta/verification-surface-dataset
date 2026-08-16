import fs from 'fs';
const content = fs.readFileSync('src/main.js', 'utf8');
console.log(content.slice(0, 3000));
console.log('---CHUNK 2---');
console.log(content.slice(3000, 6000));
console.log('---CHUNK 3---');
console.log(content.slice(6000));
