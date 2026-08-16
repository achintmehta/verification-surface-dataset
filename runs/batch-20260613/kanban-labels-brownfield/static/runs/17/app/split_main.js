import fs from 'fs';
const content = fs.readFileSync('src/main.js', 'utf8');
fs.writeFileSync('src/main_part1.js', content.slice(0, 3000));
fs.writeFileSync('src/main_part2.js', content.slice(3000, 6000));
fs.writeFileSync('src/main_part3.js', content.slice(6000));
