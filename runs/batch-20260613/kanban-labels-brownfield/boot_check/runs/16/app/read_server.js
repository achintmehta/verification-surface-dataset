import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
console.log(content.slice(0, 2000));
console.log('---CHUNK 1---');
console.log(content.slice(2000, 4000));
console.log('---CHUNK 2---');
console.log(content.slice(4000, 6000));
console.log('---CHUNK 3---');
console.log(content.slice(6000, 8000));
