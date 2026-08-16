import fs from 'fs';

let code = fs.readFileSync('src/main.js', 'utf8');

const newVars = `
let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
`;
code = code.replace(/let board = \{ columns: \[\] \};\nlet draggedCardId = null;/, newVars.trim());

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
    <div class="toolbar">
      <div class="filter-bar">
        <strong>Filter:</strong>
        \${labels.map(label => \`
          <label class="filter-label">
            <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabelIds.has(label.id) ? 'checked' : ''}>
            <span class="chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
          </label>
        \`).join('')}
        \${selectedLabelIds.size > 0 ? \`<button id="clear-filter">Clear</button>\` : ''}
      </div>
      <button id="manage-labels-btn">Manage Labels</button>
    </div>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <dialog id="label-manager-dialog">
      <form method="dialog">
        <h2>Manage Labels</h2>
        <ul id="label-list">
          \${labels.map(label => \`
            <li>
              <input type="color" value="\${escapeHtml(label.color)}" data-id="\${escapeHtml(label.id)}" class="edit-label-color">
              <input type="text" value="\${escapeHtml(label.name)}" data-id="\${escapeHtml(label.id)}" class="edit-label-name">
              <button type="button" data-id="\${escapeHtml(label.id)}" class="delete-label-btn">Delete</button>
            </li>
          \`).join('')}
        </ul>
        <div class="add-label-form">
          <input type="color" id="new-label-color" value="#ff0000">
          <input type="text" id="new-label-name" placeholder="New label name">
          <button type="button" id="add-label-btn">Add</button>
        </div>
        <button type="submit">Close</button>
      </form>
    </dialog>
  \`;
  bindEvents();
}

function renderColumn(column) {
  return \`
    <section class="column" data-column-id="\${escapeHtml(column.id)}">
      <h2>\${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="\${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="\${escapeHtml(column.id)}">
        \${column.cards.map(renderCard).join('')}
      </div>
    </section>
  \`;
}

function renderCard(card) {
  if (selectedLabelIds.size > 0) {
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    let hasMatch = false;
    for (const id of selectedLabelIds) {
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
            <button type="button" class="remove-label-btn" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${escapeHtml(label.id)}">&times;</button>
          </span>
        \`).join('')}
        <div class="assign-label-dropdown">
          <button type="button" class="assign-label-btn">+</button>
          <div class="dropdown-content">
            \${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(label => \`
              <button type="button" class="assign-specific-label-btn" data-card-id="\${escapeHtml(card.id)}" data-label-id="\${escapeHtml(label.id)}">
                <span class="chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
              </button>
            \`).join('')}
          </div>
        </div>
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
    </article>
  \`;
}
`;

code = code.replace(/function render\(\) \{[\s\S]*?function bindEvents\(\) \{/m, renderReplacement.trim() + '\n\nfunction bindEvents() {');

const bindEventsAdditions = `
  document.querySelectorAll('.filter-label input').forEach(input => {
    input.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabelIds.add(e.target.value);
      } else {
        selectedLabelIds.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  if (manageLabelsBtn) {
    manageLabelsBtn.addEventListener('click', () => {
      document.getElementById('label-manager-dialog').showModal();
    });
  }

  document.getElementById('add-label-btn')?.addEventListener('click', async () => {
    const nameInput = document.getElementById('new-label-name');
    const colorInput = document.getElementById('new-label-color');
    const name = nameInput.value.trim();
    const color = colorInput.value;
    if (!name) return;
    try {
      const res = await fetch(\`\${API_BASE}/api/labels\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      if (!res.ok) throw new Error((await res.json()).error);
      nameInput.value = '';
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.edit-label-name').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const name = e.target.value.trim();
      const colorInput = document.querySelector(\`.edit-label-color[data-id="\${id}"]\`);
      const color = colorInput.value;
      if (!name) return;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.edit-label-color').forEach(input => {
    input.addEventListener('change', async (e) => {
      const id = e.target.dataset.id;
      const color = e.target.value;
      const nameInput = document.querySelector(\`.edit-label-name[data-id="\${id}"]\`);
      const name = nameInput.value.trim();
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${id}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = e.target.dataset.id;
      try {
        const res = await fetch(\`\${API_BASE}/api/labels/\${id}\`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.remove-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.target.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels/\${labelId}\`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelectorAll('.assign-specific-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.currentTarget.dataset.cardId;
      const labelId = e.currentTarget.dataset.labelId;
      try {
        const res = await fetch(\`\${API_BASE}/api/cards/\${cardId}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId })
        });
        if (!res.ok) throw new Error((await res.json()).error);
      } catch (err) {
        alert(err.message);
      }
    });
  });
`;

code = code.replace(/function bindEvents\(\) \{/, 'function bindEvents() {\n' + bindEventsAdditions);

const applyMutationReplacement = `
function applyMutation(message) {
  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    return;
  }
  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    if (message.board) board = normalizeBoard(message.board);
    render();
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

code = code.replace(/function applyMutation\(message\) \{[\s\S]*?\}\n/m, applyMutationReplacement.trim() + '\n');

const loadLabelsReplacement = `
async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await Promise.all([loadBoard(), loadLabels()]);
    connectStream();
  } catch (error) {
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}
`;

code = code.replace(/async function start\(\) \{[\s\S]*?\}\n/m, loadLabelsReplacement.trim() + '\n');

fs.writeFileSync('src/main.js', code);
