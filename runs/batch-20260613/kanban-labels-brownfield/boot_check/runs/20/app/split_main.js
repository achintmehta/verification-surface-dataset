import fs from 'fs';
const content = fs.readFileSync('src/main.js', 'utf8');
fs.writeFileSync('src_main_1.js', content.slice(0, 3000));
fs.writeFileSync('src_main_2.js', content.slice(3000, 6000));
fs.writeFileSync('src_main_3.js', content.slice(6000));
