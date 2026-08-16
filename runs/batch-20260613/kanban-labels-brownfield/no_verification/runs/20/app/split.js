import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
fs.writeFileSync('server/index.js.part1', content.slice(0, 3000));
fs.writeFileSync('server/index.js.part2', content.slice(3000, 6000));
fs.writeFileSync('server/index.js.part3', content.slice(6000));
