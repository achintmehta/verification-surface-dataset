import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /async function start\(\) \{[\s\S]*?start\(\);/,
  `async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await Promise.all([loadBoard(), loadLabels()]);
    connectStream();
  } catch (error) {
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}

start();`
);

fs.writeFileSync('src/main.js', code);
