import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// 1. Add state
code = code.replace(
  "let board = { columns: [] };",
  `let board = { columns: [] };
let labels = [];
let activeFilters = new Set();`
);

// 2. Update render
code = code.replace(
  "    <main class=\"board\">",
  `    <section class="label-manager">
      <h3>Labels</h3>
      <div class="label-list">
        \${labels.map(renderLabelItem).join('')}
      </div>
      <form class="add-label-form">
        <input type="text" name="name" placeholder="New label name" required />
        <input type="color" name="color" value="#3b82f6" />
        <button type="submit">Add Label</button>
      </form>
    </section>
    <section class="filter-bar">
      <h3>Filter:</h3>
      <div class="filter-labels">
        \${labels.map(renderFilterLabel).join('')}
      </div>
      \${activeFilters.size > 0 ? '<button class="clear-filters">Clear</button>' : ''}
    </section>
    <main class="board">`
);

// 3. Add render functions for labels
code = code.replace(
  "function renderColumn(column) {",
  `function renderLabelItem(label) {
  return \`
    <div class="label-item" data-label-id="\${escapeHtml(label.id)}">
      <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
      <button class="delete-label" title="Delete">×</button>
    </div>
  \`;
}

function renderFilterLabel(label) {
  const isActive = activeFilters.has(label.id);
  return \`
    <span class="label-chip filter-label \${isActive ? 'active' : ''}" data-label-id="\${escapeHtml(label.id)}" style="background-color: \${escapeHtml(label.color)}">
      \${escapeHtml(label.name)}
    </span>
  \`;
}

function renderColumn(column) {`
);

// 4. Update renderCard to include labels and filter logic
code = code.replace(
  "function renderCard(card) {",
  `function renderCard(card) {
  if (activeFilters.size > 0) {
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    let hasMatch = false;
    for (const filterId of activeFilters) {
      if (cardLabelIds.has(filterId)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return '';
  }

  const unassignedLabels = labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id));

  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${(card.labels || []).map(l => \`<span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)} <button class="unassign-label" data-label-id="\${escapeHtml(l.id)}" style="background:none;border:none;color:white;cursor:pointer;padding:0;margin-left:2px;">×</button></span>\`).join('')}
      </div>
      \${escapeHtml(card.text)}
      <div class="card-label-assign">
        \${unassignedLabels.length > 0 ? \`
          <select class="assign-label-select">
            <option value="">Add label...</option>
            \${unassignedLabels.map(l => \`<option value="\${escapeHtml(l.id)}">\${escapeHtml(l.name)}</option>\`).join('')}
          </select>
          <button class="assign-label-btn">Add</button>
        \` : ''}
      </div>
    </article>
  \`;
}`
);

// Remove the old renderCard function
code = code.replace(
  /function renderCard\(card\) \{\s*return `\s*<article class="card" draggable="true" data-card-id="\$\{escapeHtml\(card\.id\)\}" title="Drag to move">\s*\$\{escapeHtml\(card\.text\)\}\s*<\/article>\s*`;\s*\}/,
  ""
);

// 5. Add event listeners for labels
code = code.replace(
  "function bindEvents() {",
  `function bindEvents() {
  const addLabelForm = document.querySelector('.add-label-form');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (!name) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Failed to create label');
        addLabelForm.reset();
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  }

  document.querySelectorAll('.delete-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${labelId}\`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to delete label');
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.filter-label').forEach(el => {
    el.addEventListener('click', () => {
      const labelId = el.dataset.labelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  const clearFiltersBtn = document.querySelector('.clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  document.querySelectorAll('.assign-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardEl = e.target.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const select = cardEl.querySelector('.assign-label-select');
      const labelId = select.value;
      if (!labelId) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!response.ok) throw new Error('Failed to assign label');
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.unassign-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardEl = e.target.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, { method: 'DELETE' });
        if (!response.ok) throw new Error('Failed to unassign label');
      } catch (error) {
        setStatus(\`Error: \${error.message}\`, true);
      }
    });
  });
`
);

// 6. Handle SSE events for labels
code = code.replace(
  "function applyMutation(message) {",
  `function applyMutation(message) {
  if (message.type === 'createLabel') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'updateLabel') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update labels in cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) card.labels[lIndex] = message.label;
          }
        }
      }
      render();
    }
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    // Remove from cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    return;
  }
  if (message.type === 'assignLabel' || message.type === 'unassignLabel') {
    const target = findCard(message.cardId);
    if (target) {
      target.card.labels = message.card.labels;
      render();
    }
    return;
  }
`
);

// 7. Fetch labels on load
code = code.replace(
  "async function loadBoard() {",
  `async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function loadBoard() {`
);

code = code.replace(
  "await loadBoard();",
  `await loadLabels();
    await loadBoard();`
);

fs.writeFileSync('src/main.js', code);
