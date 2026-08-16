import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// Add state variables
code = code.replace(/let board = \{ columns: \[\] \};/, `let board = { columns: [] };\nlet labels = [];\nlet selectedFilterLabels = new Set();\nlet showLabelManager = false;`);

// Add loadLabels
const loadLabelsCode = `
async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}
`;
code = code.replace(/async function loadBoard\(\) \{/, loadLabelsCode + '\nasync function loadBoard() {');

// Update start
code = code.replace(/await loadBoard\(\);\n    connectStream\(\);/, `await loadLabels();\n    await loadBoard();\n    connectStream();`);

// Update render
const renderCode = `
function render() {
  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="toolbar">
      <div class="filters">
        <strong>Filter by Label:</strong>
        \${labels.map(label => \`
          <label class="filter-label">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedFilterLabels.has(label.id) ? 'checked' : ''} class="filter-checkbox" />
            <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
          </label>
        \`).join('')}
        \${selectedFilterLabels.size > 0 ? \`<button id="clear-filters">Clear</button>\` : ''}
      </div>
      <button id="toggle-label-manager">Manage Labels</button>
    </div>
    \${showLabelManager ? renderLabelManager() : ''}
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
  \`;
  bindEvents();
}

function renderLabelManager() {
  return \`
    <div class="label-manager">
      <h2>Manage Labels</h2>
      <form id="create-label-form">
        <input type="text" name="name" placeholder="Label name" required />
        <input type="color" name="color" value="#ff0000" required />
        <button type="submit">Create Label</button>
      </form>
      <ul class="label-list">
        \${labels.map(label => \`
          <li>
            <form class="update-label-form" data-label-id="\${escapeHtml(label.id)}">
              <input type="text" name="name" value="\${escapeHtml(label.name)}" required />
              <input type="color" name="color" value="\${escapeHtml(label.color)}" required />
              <button type="submit">Save</button>
              <button type="button" class="delete-label-btn" data-label-id="\${escapeHtml(label.id)}">Delete</button>
            </form>
          </li>
        \`).join('')}
      </ul>
    </div>
  \`;
}
`;
code = code.replace(/function render\(\) \{[\s\S]*?bindEvents\(\);\n\}/, renderCode.trim());

// Update renderCard
const renderCardCode = `
function renderCard(card) {
  if (selectedFilterLabels.size > 0) {
    const cardLabelIds = (card.labels || []).map(l => l.id);
    const hasMatch = [...selectedFilterLabels].some(id => cardLabelIds.includes(id));
    if (!hasMatch) return '';
  }

  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${(card.labels || []).map(label => \`
          <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">
            \${escapeHtml(label.name)}
            <button class="unassign-label-btn" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${escapeHtml(label.id)}">&times;</button>
          </span>
        \`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <select class="assign-label-select" data-card-id="\${escapeHtml(card.id)}">
          <option value="">Add label...</option>
          \${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(label => \`
            <option value="\${escapeHtml(label.id)}">\${escapeHtml(label.name)}</option>
          \`).join('')}
        </select>
      </div>
    </article>
  \`;
}
`;
code = code.replace(/function renderCard\(card\) \{[\s\S]*?<\/article>\n  `;\n\}/, renderCardCode.trim());

// Update bindEvents
const bindEventsAdditions = `
  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedFilterLabels.add(e.target.value);
      } else {
        selectedFilterLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      selectedFilterLabels.clear();
      render();
    });
  }

  const toggleLabelManagerBtn = document.getElementById('toggle-label-manager');
  if (toggleLabelManagerBtn) {
    toggleLabelManagerBtn.addEventListener('click', () => {
      showLabelManager = !showLabelManager;
      render();
    });
  }

  const createLabelForm = document.getElementById('create-label-form');
  if (createLabelForm) {
    createLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createLabelForm.elements.name.value.trim();
      const color = createLabelForm.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to create label');
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  }

  document.querySelectorAll('.update-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const labelId = form.dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to update label');
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete label');
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });

  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = select.dataset.cardId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to assign label');
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });

  document.querySelectorAll('.unassign-label-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error((await res.json()).error || 'Failed to unassign label');
      } catch (err) {
        setStatus(err.message, true);
      }
    });
  });
`;
code = code.replace(/function bindEvents\(\) \{/, 'function bindEvents() {\n' + bindEventsAdditions);

// Update applyMutation
const applyMutationCode = `
function applyMutation(message) {
  if (message.type === 'createLabel') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
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
      setStatus('Synced');
    }
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedFilterLabels.delete(message.labelId);
    // Remove from cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'assignLabel' || message.type === 'unassignLabel') {
    const card = message.card;
    const existing = findCard(card.id);
    if (existing) {
      existing.card.labels = card.labels;
      render();
      setStatus('Synced');
    }
    return;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = message.card;
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}
`;
code = code.replace(/function applyMutation\(message\) \{[\s\S]*?setStatus\('Synced'\);\n\}/, applyMutationCode.trim());

fs.writeFileSync('src/main.js', code);
