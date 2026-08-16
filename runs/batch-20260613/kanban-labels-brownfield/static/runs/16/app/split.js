import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
fs.writeFileSync('server/index_part1.js', content.slice(0, 3000));
fs.writeFileSync('server/index_part2.js', content.slice(3000, 6000));
fs.writeFileSync('server/index_part3.js', content.slice(6000));
