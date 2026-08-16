import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /await loadBoard\(\);/,
  `await loadLabels();
    await loadBoard();`
);

fs.writeFileSync('src/main.js', code);
