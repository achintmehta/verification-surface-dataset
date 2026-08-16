import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /  return `\n    <article class="card" draggable="true" data-card-id="\$\{escapeHtml\(card\.id\)\}" title="Drag to move">\n      \$\{escapeHtml\(card\.text\)\}\n    <\/article>\n  `;\n\}/,
  ""
);

fs.writeFileSync('src/main.js', code);
