import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

// Add state for labels and filters
const stateReplacement = `
let board = { columns: [] };
let labels = [];
let selectedLabels = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
`;
code = code.replace(/let board = \{ columns: \[\] \};\nlet draggedCardId = null;\nlet eventSource = null;\nlet statusTimer = null;/, stateReplacement);

// Update render to include filter bar and label manager
const renderReplacement = `
function render() {
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
          <label class="filter-label">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabels.has(label.id) ? 'checked' : ''}>
            <span class="chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
          </label>
        \`).join('')}
        \${selectedLabels.size > 0 ? '<button id="clear-filters">Clear</button>' : ''}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager">
      <div class="dialog-content">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          \${labels.map(label => \`
            <li>
              <form class="edit-label-form" data-label-id="\${escapeHtml(label.id)}">
                <input type="color" name="color" value="\${escapeHtml(label.color)}">
                <input type="text" name="name" value="\${escapeHtml(label.name)}" required>
                <button type="submit">Save</button>
                <button type="button" class="delete-label-btn" data-label-id="\${escapeHtml(label.id)}">Delete</button>
              </form>
            </li>
          \`).join('')}
        </ul>
        <form id="create-label-form">
          <input type="color" name="color" value="#ff0000">
          <input type="text" name="name" placeholder="New label name" required>
          <button type="submit">Create</button>
        </form>
        <button id="close-label-manager">Close</button>
      </div>
    </dialog>
  \`;
  bindEvents();
}
`;
code = code.replace(/function render\(\) \{[\s\S]*?bindEvents\(\);\n\}/, renderReplacement);

// Update renderCard to include labels and assign/unassign UI
const renderCardReplacement = `
function renderCard(card) {
  if (selectedLabels.size > 0) {
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    let hasMatch = false;
    for (const id of selectedLabels) {
      if (cardLabelIds.has(id)) {
        hasMatch = true;
        break;
      }
    }
    if (!hasMatch) return '';
  }

  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${(card.labels || []).map(label => \`
          <span class="chip" style="background-color: \${escapeHtml(label.color)}">
            \${escapeHtml(label.name)}
            <button class="remove-label-btn" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${escapeHtml(label.id)}">&times;</button>
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
code = code.replace(/function renderCard\(card\) \{[\s\S]*?<\/article>\n  `;\n\}/, renderCardReplacement);

// Add label API functions
const labelApiFunctions = `
async function createLabel(name, color) {
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
`;
code = code.replace(/async function createCard\(columnId, text\) \{/, labelApiFunctions + '\nasync function createCard(columnId, text) {');

// Update bindEvents to include label events
const bindEventsReplacement = `
function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      await createCard(form.dataset.columnId, text);
    });
  });

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      if (event.target.tagName === 'BUTTON' || event.target.tagName === 'SELECT' || event.target.tagName === 'OPTION') {
        event.preventDefault();
        return;
      }
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/move\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(\`Move rejected: \${error.message}\`, true);
        await loadBoard();
      }
    });
  });

  // Label filtering
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

  const clearFiltersBtn = document.getElementById('clear-filters');
  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  // Label manager dialog
  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  const labelManager = document.getElementById('label-manager');
  const closeLabelManagerBtn = document.getElementById('close-label-manager');

  if (manageLabelsBtn && labelManager) {
    manageLabelsBtn.addEventListener('click', () => {
      labelManager.showModal();
    });
  }

  if (closeLabelManagerBtn && labelManager) {
    closeLabelManagerBtn.addEventListener('click', () => {
      labelManager.close();
    });
  }

  // Create label
  const createLabelForm = document.getElementById('create-label-form');
  if (createLabelForm) {
    createLabelForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createLabelForm.elements.name.value.trim();
      const color = createLabelForm.elements.color.value;
      if (name) {
        await createLabel(name, color);
        createLabelForm.reset();
      }
    });
  }

  // Edit label
  document.querySelectorAll('.edit-label-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = form.dataset.labelId;
      const name = form.elements.name.value.trim();
      const color = form.elements.color.value;
      if (name) {
        await updateLabel(id, name, color);
      }
    });
  });

  // Delete label
  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.labelId;
      await deleteLabel(id);
    });
  });

  // Assign label
  document.querySelectorAll('.assign-label-select').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (labelId) {
        const cardId = e.target.dataset.cardId;
        await assignLabel(cardId, labelId);
        e.target.value = ''; // Reset select
      }
    });
  });

  // Unassign label
  document.querySelectorAll('.remove-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.target.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      await unassignLabel(cardId, labelId);
    });
  });
}
`;
code = code.replace(/function bindEvents\(\) \{[\s\S]*?function getDragAfterElement/, bindEventsReplacement + '\nfunction getDragAfterElement');

// Update applyMutation to handle label mutations
const applyMutationReplacement = `
function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      
      // Update labels in cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          if (card.labels) {
            const lIndex = card.labels.findIndex(l => l.id === message.label.id);
            if (lIndex !== -1) {
              card.labels[lIndex] = message.label;
            }
          }
        }
      }
      render();
      setStatus('Synced');
    }
    return;
  }

  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabels.delete(message.labelId);
    
    // Remove label from cards
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

  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    if (message.card) {
      const found = findCard(message.card.id);
      if (found) {
        found.card.labels = message.card.labels;
        render();
        setStatus('Synced');
      }
    }
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
code = code.replace(/function applyMutation\(message\) \{[\s\S]*?setStatus\('Synced'\);\n\}/, applyMutationReplacement);

// Update loadBoard to also load labels
const loadBoardReplacement = `
async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(\`\${API_BASE}/api/board\`),
    fetch(\`\${API_BASE}/api/labels\`)
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  if (!labelsResponse.ok) throw new Error('Could not load labels');
  
  board = normalizeBoard(await boardResponse.json());
  labels = await labelsResponse.json();
  render();
}
`;
code = code.replace(/async function loadBoard\(\) \{[\s\S]*?render\(\);\n\}/, loadBoardReplacement);

fs.writeFileSync('src/main.js', code);
