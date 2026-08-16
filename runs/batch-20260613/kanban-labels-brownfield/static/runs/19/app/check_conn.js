import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
console.log(content.includes('const cardLabelsResult = await conn.query('));
