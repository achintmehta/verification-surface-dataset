import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  "  try {\n    await loadBoard();\n    connectStream();",
  "  try {\n    await loadLabels();\n    await loadBoard();\n    connectStream();"
);

fs.writeFileSync('src/main.js', code);
