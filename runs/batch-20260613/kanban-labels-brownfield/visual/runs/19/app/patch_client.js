import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// Add labels state
code = code.replace(
  "let board = { columns: [] };",
  "let board = { columns: [] };\nlet labels = [];\nlet selectedLabelIds = new Set();"
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
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="controls">
      <div class="filter-bar">
        <strong>Filter:</strong>
        \${labels.map(label => \`
          <label class="filter-label" style="--label-color: \${label.color}">
            <input type="checkbox" value="\${label.id}" \${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            \${escapeHtml(label.name)}
          </label>
        \`).join('')}
        \${selectedLabelIds.size > 0 ? \`<button class="clear-filter">Clear</button>\` : ''}
      </div>
      <button class="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <div class="label-list">
          \${labels.map(label => \`
            <div class="label-item" data-label-id="\${label.id}">
              <input type="color" value="\${label.color}" class="edit-label-color" />
              <input type="text" value="\${escapeHtml(label.name)}" class="edit-label-name" />
              <button type="button" class="save-label-btn">Save</button>
              <button type="button" class="delete-label-btn">Delete</button>
            </div>
          \`).join('')}
        </div>
        <h3>Create New Label</h3>
        <div class="create-label">
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
  /function renderColumn\(column\) \{[\s\S]*?return `[\s\S]*?`;\n\}/,
  `function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    return card.labels && card.labels.some(l => selectedLabelIds.has(l.id));
  });

  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${filteredCards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}`
);

// Update renderCard
code = code.replace(
  /function renderCard\(card\) \{[\s\S]*?return `[\s\S]*?`;\n\}/,
  `function renderCard(card) {
  const cardLabels = card.labels || [];
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(l => \`<span class="label-chip" style="background-color: \${l.color}" title="\${escapeHtml(l.name)}"></span>\`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <button type="button" class="assign-label-btn" data-card-id="\${escapeHtml(card.id)}">🏷️</button>
      </div>
      <div class="label-dropdown hidden" data-card-id="\${escapeHtml(card.id)}">
        \${labels.map(label => {
          const hasLabel = cardLabels.some(l => l.id === label.id);
          return \`
            <label>
              <input type="checkbox" class="card-label-checkbox" data-label-id="\${label.id}" \${hasLabel ? 'checked' : ''} />
              <span class="label-chip" style="background-color: \${label.color}"></span>
              \${escapeHtml(label.name)}
            </label>
          \`;
        }).join('')}
      </div>
    </article>
  \`;
}`
);

// Add loadLabels
code = code.replace(
  "async function loadBoard() {",
  `async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function loadBoard() {`
);

// Update start
code = code.replace(
  /async function start\(\) \{[\s\S]*?await loadBoard\(\);[\s\S]*?\}/,
  `async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await Promise.all([loadBoard(), loadLabels()]);
    connectStream();
  } catch (error) {
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }`
);

fs.writeFileSync('src/main.js', code);
