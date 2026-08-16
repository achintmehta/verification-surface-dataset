import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /async function loadBoard\(\) \{[\s\S]*?render\(\);\n\}/,
  `async function loadBoard() {
  const response = await fetch(\`\${API_BASE}/api/board\`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}`
);

code = code.replace(
  /async function start\(\) \{[\s\S]*?connectStream\(\);/,
  `async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();`
);

// Fix document.addEventListener in bindEvents
code = code.replace(
  /document\.addEventListener\('click', \(e\) => \{[\s\S]*?\}\);/,
  `// document click listener is handled outside`
);

fs.writeFileSync('src/main.js', code);
