import fs from 'fs';
const content = fs.readFileSync('src/main.js', 'utf8');
fs.writeFileSync('src_main_part1.js', content.slice(0, 3000));
fs.writeFileSync('src_main_part2.js', content.slice(3000));
