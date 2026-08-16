import fs from 'fs';
import { parse } from 'acorn';
try {
  parse(fs.readFileSync('src/main.js', 'utf8'), { ecmaVersion: 2022, sourceType: 'module' });
  console.log('Syntax OK');
} catch (e) {
  console.error(e);
}
