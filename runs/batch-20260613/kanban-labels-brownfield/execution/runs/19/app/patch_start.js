import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  "async function start() {\\n  app.innerHTML = '<div class=\"loading\">Loading board…</div>';\\n  try {\\n    await loadBoard();",
  "async function start() {\\n  app.innerHTML = '<div class=\"loading\">Loading board…</div>';\\n  try {\\n    await loadLabels();\\n    await loadBoard();"
);

fs.writeFileSync('src/main.js', code);
