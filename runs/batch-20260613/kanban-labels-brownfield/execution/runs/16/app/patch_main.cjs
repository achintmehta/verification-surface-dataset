const fs = require('fs');
let code = fs.readFileSync('src/main.js', 'utf8');

// Add global variables
code = code.replace(
  /let board = \{ columns: \[\] \};/,
  `let board = { columns: [] };
let allLabels = [];
let selectedLabels = new Set();`
);

// Add loadLabels
code = code.replace(
  /async function loadBoard\(\) \{/,
  `async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  allLabels = await response.json();
}

async function loadBoard() {`
);

// Update start
code = code.replace(
  /await loadBoard\(\);/,
  `await Promise.all([loadBoard(), loadLabels()]);`
);

// Update render
code = code.replace(
  /function render\(\) \{[\s\S]*?bindEvents\(\);\n\}/,
  `function render() {
  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="controls">
        <div class="filter-bar">
          \${allLabels.map(label => \`
            <label class="filter-label" style="--label-color: \${label.color}">
              <input type="checkbox" value="\${label.id}" \${selectedLabels.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
              \${escapeHtml(label.name)}
            </label>
          \`).join('')}
          \${selectedLabels.size > 0 ? \`<button id="clear-filter">Clear</button>\` : ''}
        </div>
        <button id="manage-labels-btn">Manage Labels</button>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          \${allLabels.map(label => \`
            <li>
              <input type="color" value="\${label.color}" data-id="\${label.id}" class="edit-label-color" />
              <input type="text" value="\${escapeHtml(label.name)}" data-id="\${label.id}" class="edit-label-name" />
              <button type="button" data-id="\${label.id}" class="delete-label-btn">Delete</button>
            </li>
          \`).join('')}
        </ul>
        <h3>Create Label</h3>
        <div class="create-label-form">
          <input type="color" id="new-label-color" value="#ff0000" />
          <input type="text" id="new-label-name" placeholder="Label name" />
          <button type="button" id="create-label-btn">Create</button>
        </div>
        <button type="submit">Close</button>
      </form>
    </dialog>
  \`;
  bindEvents();
}`
);

// Update renderColumn
code = code.replace(
  /function renderColumn\(column\) \{[\s\S]*?return \`[\s\S]*?\`;\n\}/,
  `function renderColumn(column) {
  const visibleCards = column.cards.filter(card => {
    if (selectedLabels.size === 0) return true;
    return card.labels && card.labels.some(l => selectedLabels.has(l.id));
  });

  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}`
);

// Update renderCard
code = code.replace(
  /function renderCard\(card\) \{[\s\S]*?return \`[\s\S]*?\`;\n\}/,
  `function renderCard(card) {
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${(card.labels || []).map(l => \`
          <span class="label-chip" style="--label-color: \${l.color}" title="\${escapeHtml(l.name)}">
            \${escapeHtml(l.name)}
            <button type="button" class="remove-label-btn" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${l.id}">&times;</button>
          </span>
        \`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      <div class="assign-label-dropdown">
        <select class="assign-label-select" data-card-id="\${escapeHtml(card.id)}">
          <option value="">+ Label</option>
          \${allLabels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => \`
            <option value="\${l.id}">\${escapeHtml(l.name)}</option>
          \`).join('')}
        </select>
      </div>
    </article>
  \`;
}`
);

fs.writeFileSync('src/main.js', code);
