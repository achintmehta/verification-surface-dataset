import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// Add state for labels and filters
code = code.replace(
  /let statusTimer = null;/,
  `let statusTimer = null;
let labels = [];
let selectedLabels = new Set();
let isLabelManagerOpen = false;`
);

// Add loadLabels function
code = code.replace(
  /async function loadBoard\(\) {/,
  `async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function loadBoard() {`
);

// Update start function to load labels
code = code.replace(
  /await loadBoard\(\);/,
  `await loadLabels();
    await loadBoard();`
);

// Update render function to include filter bar and label manager
code = code.replace(
  /function render\(\) {[\s\S]*?bindEvents\(\);\n}/,
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
        <span>Filter by labels:</span>
        \${labels.map(label => \`
          <label class="filter-label" style="--label-color: \${escapeHtml(label.color)}">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabels.has(label.id) ? 'checked' : ''}>
            \${escapeHtml(label.name)}
          </label>
        \`).join('')}
        \${selectedLabels.size > 0 ? \`<button class="clear-filters">Clear</button>\` : ''}
      </div>
      <button class="toggle-label-manager">Manage Labels</button>
    </div>
    \${isLabelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
  \`;
  bindEvents();
}

function renderLabelManager() {
  return \`
    <div class="label-manager">
      <h3>Manage Labels</h3>
      <form class="add-label">
        <input name="name" type="text" placeholder="Label name" required />
        <input name="color" type="color" value="#ff0000" required />
        <button type="submit">Add Label</button>
      </form>
      <ul class="label-list">
        \${labels.map(label => \`
          <li data-label-id="\${escapeHtml(label.id)}">
            <form class="edit-label">
              <input name="name" type="text" value="\${escapeHtml(label.name)}" required />
              <input name="color" type="color" value="\${escapeHtml(label.color)}" required />
              <button type="submit">Save</button>
              <button type="button" class="delete-label">Delete</button>
            </form>
          </li>
        \`).join('')}
      </ul>
    </div>
  \`;
}`
);

// Update renderColumn to filter cards
code = code.replace(
  /\$\{column\.cards\.map\(renderCard\)\.join\(''\)\}/,
  `\${column.cards.filter(card => {
          if (selectedLabels.size === 0) return true;
          return card.labels && card.labels.some(l => selectedLabels.has(l.id));
        }).map(renderCard).join('')}`
);

// Update renderCard to include labels and assign/unassign UI
code = code.replace(
  /function renderCard\(card\) {[\s\S]*?<\/article>\n  `;\n}/,
  `function renderCard(card) {
  const cardLabels = card.labels || [];
  const unassignedLabels = labels.filter(l => !cardLabels.some(cl => cl.id === l.id));
  
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(label => \`
          <span class="card-label" style="--label-color: \${escapeHtml(label.color)}">
            \${escapeHtml(label.name)}
            <button class="remove-label" data-label-id="\${escapeHtml(label.id)}">&times;</button>
          </span>
        \`).join('')}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
      \${unassignedLabels.length > 0 ? \`
        <div class="assign-label-container">
          <select class="assign-label-select">
            <option value="">Add label...</option>
            \${unassignedLabels.map(l => \`<option value="\${escapeHtml(l.id)}">\${escapeHtml(l.name)}</option>\`).join('')}
          </select>
        </div>
      \` : ''}
    </article>
  \`;
}`
);

// Add label API functions
code = code.replace(
  /async function createCard\(columnId, text\) {/,
  `async function createLabel(name, color) {
  try {
    const response = await fetch(\`\${API_BASE}/api/labels\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
  } catch (error) {
    setStatus(\`Create label failed: \${error.message}\`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(\`Update label failed: \${error.message}\`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
  } catch (error) {
    setStatus(\`Delete label failed: \${error.message}\`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
  } catch (error) {
    setStatus(\`Assign label failed: \${error.message}\`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
  } catch (error) {
    setStatus(\`Unassign label failed: \${error.message}\`, true);
  }
}

async function createCard(columnId, text) {`
);

// Update bindEvents to include label events
code = code.replace(
  /function bindEvents\(\) {/,
  `function bindEvents() {
  const toggleBtn = document.querySelector('.toggle-label-manager');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      isLabelManagerOpen = !isLabelManagerOpen;
      render();
    });
  }

  document.querySelectorAll('.filter-label input').forEach(input => {
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearBtn = document.querySelector('.clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  const addLabelForm = document.querySelector('.add-label');
  if (addLabelForm) {
    addLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = addLabelForm.elements.name.value.trim();
      const color = addLabelForm.elements.color.value;
      if (name) {
        await createLabel(name, color);
      }
    });
  }

  document.querySelectorAll('.edit-label').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.closest('li').dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (name) {
        await updateLabel(id, name, color);
      }
    });

    const deleteBtn = form.querySelector('.delete-label');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', async () => {
        const id = form.closest('li').dataset.labelId;
        await deleteLabel(id);
      });
    }
  });

  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (labelId) {
        const cardId = select.closest('.card').dataset.cardId;
        await assignLabel(cardId, labelId);
      }
    });
  });

  document.querySelectorAll('.remove-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = btn.dataset.labelId;
      const cardId = btn.closest('.card').dataset.cardId;
      await unassignLabel(cardId, labelId);
    });
  });
`
);

// Update applyMutation to handle label mutations
code = code.replace(
  /function applyMutation\(message\) {/,
  `function applyMutation(message) {
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
    }
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'deleteLabel') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'assignLabel' || message.type === 'unassignLabel') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }
`
);

fs.writeFileSync('src/main.js', code);
