import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const loadBoardReplacement = `async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(\`\${API_BASE}/api/board\`),
    fetch(\`\${API_BASE}/api/labels\`)
  ]);
  if (!boardRes.ok || !labelsRes.ok) throw new Error('Could not load board or labels');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
  render();
}`;

code = code.replace(/async function loadBoard\(\) \{[\s\S]*?render\(\);\n\}/m, loadBoardReplacement);
fs.writeFileSync('src/main.js', code);
