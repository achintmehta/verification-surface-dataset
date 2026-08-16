import fs from 'fs';
const content = fs.readFileSync('server/index.js.bak', 'utf8');
fs.writeFileSync('chunk1.txt', content.slice(0, 2000));
fs.writeFileSync('chunk2.txt', content.slice(2000, 4000));
fs.writeFileSync('chunk3.txt', content.slice(4000, 6000));
fs.writeFileSync('chunk4.txt', content.slice(6000, 8000));
process.exit(1); // to make check_boot return the crash log
