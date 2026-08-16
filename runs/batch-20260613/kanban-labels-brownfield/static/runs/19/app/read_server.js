import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
fs.writeFileSync('server_part1.js', content.slice(0, 2000));
fs.writeFileSync('server_part2.js', content.slice(2000, 4000));
fs.writeFileSync('server_part3.js', content.slice(4000, 6000));
fs.writeFileSync('server_part4.js', content.slice(6000, 8000));
fs.writeFileSync('server_part5.js', content.slice(8000));
