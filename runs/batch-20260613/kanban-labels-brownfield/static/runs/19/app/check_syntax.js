import fs from 'fs';
try {
  new Function(fs.readFileSync('src/main.js', 'utf8'));
  console.log('Syntax OK');
} catch (e) {
  console.error(e);
}
