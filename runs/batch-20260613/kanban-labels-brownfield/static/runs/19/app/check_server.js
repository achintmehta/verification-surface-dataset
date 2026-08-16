import fs from 'fs';
const content = fs.readFileSync('server/index.js', 'utf8');
console.log(content.includes('CREATE TABLE IF NOT EXISTS labels'));
console.log(content.includes('app.post(\'/api/labels\''));
