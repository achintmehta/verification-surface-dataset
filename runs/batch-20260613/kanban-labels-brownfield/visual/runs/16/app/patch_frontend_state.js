import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

code = code.replace(
  /let board = \{ columns: \[\] \};\nlet draggedCardId = null;\nlet eventSource = null;\nlet statusTimer = null;/,
  `let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let isLabelManagerOpen = false;
let editingLabelId = null;
let cardLabelMenuOpen = null; // cardId`
);

fs.writeFileSync('src/main.js', code);
