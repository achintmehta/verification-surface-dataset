import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
fs.writeFileSync('server_index_1.js', content.slice(0, 3000));
fs.writeFileSync('server_index_2.js', content.slice(3000, 6000));
fs.writeFileSync('server_index_3.js', content.slice(6000));
