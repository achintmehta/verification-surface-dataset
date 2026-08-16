const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'src', 'main.js');
let content = fs.readFileSync(filePath, 'utf8');

const newContent = `import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabelIds = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function findCard(cardId) {
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) return { column, index, card: column.cards[index] };
  }
  return null;
}

function removeCardEverywhere(cardId) {
  let removed = null;
  for (const column of board.columns) {
    const index = column.cards.findIndex((card) => card.id === cardId);
    if (index !== -1) {
      const [card] = column.cards.splice(index, 1);
      removed = card;
    }
  }
  return removed;
}

function normalizeBoard(nextBoard) {
  const seen = new Set();
  const columns = [...(nextBoard.columns || [])]
    .map((column) => ({
      ...column,
      cards: [...(column.cards || [])]
        .filter((card) => {
          if (seen.has(card.id)) return false;
          seen.add(card.id);
          return true;
        })
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

function render() {
  if (!document.getElementById('board')) {
    app.innerHTML = \`
      <header class="topbar">
        <div>
          <h1>Collaborative Kanban</h1>
          <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
        </div>
        <div id="status" class="status">Connecting…</div>
      </header>
      <div class="toolbar" id="toolbar"></div>
      <main class="board" id="board"></main>
      <dialog id="label-manager-dialog">
        <div class="dialog-content" id="label-manager-content"></div>
      </dialog>
    \`;
  }

  renderToolbar();
  renderLabelManager();

  document.getElementById('board').innerHTML = board.columns.map(renderColumn).join('');
  bindEvents();
}

function renderToolbar() {
  const toolbar = document.getElementById('toolbar');
  toolbar.innerHTML = \`
    <div class="filters">
      <strong>Filter:</strong>
      \${labels.map(label => \`
        <label class="filter-label">
          <input type="checkbox" value="\${escapeHtml(label.id)}" \${selectedLabelIds.has(label.id) ? 'checked' : ''} class="filter-checkbox">
          <span class="label-chip" style="background-color: \${escapeHtml(label.color)}">\${escapeHtml(label.name)}</span>
        </label>
      \`).join('')}
    </div>
    <button id="manage-labels-btn">Manage Labels</button>
  \`;

  toolbar.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabelIds.add(e.target.value);
      } else {
        selectedLabelIds.delete(e.target.value);
      }
      render();
    });
  });

  toolbar.querySelector('#manage-labels-btn').addEventListener('click', () => {
    document.getElementById('label-manager-dialog').showModal();
  });
}

function renderLabelManager() {
  const content = document.getElementById('label-manager-content');
  content.innerHTML = \`
    <h2>Manage Labels</h2>
    <ul id="label-list">
      \${labels.map(label => \`
        <li data-label-id="\${escapeHtml(label.id)}">
          <input type="color" value="\${escapeHtml(label.color)}" class="edit-label-color">
          <input type="text" value="\${escapeHtml(label.name)}" class="edit-label-name">
          <button class="save-label-btn">Save</button>
          <button class="delete-label-btn">Delete</button>
        </li>
      \`).join('')}
    </ul>
    <form id="create-label-form">
      <input type="color" name="color" value="#2563eb">
      <input type="text" name="name" placeholder="New label name" required>
      <button type="submit">Create</button>
    </form>
    <button id="close-label-manager-btn">Close</button>
  \`;

  content.querySelectorAll('.save-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const li = e.target.closest('li');
      const id = li.dataset.labelId;
      const name = li.querySelector('.edit-label-name').value;
      const color = li.querySelector('.edit-label-color').value;
      await updateLabel(id, name, color);
    });
  });

  content.querySelectorAll('.delete-label-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const li = e.target.closest('li');
      const id = li.dataset.labelId;
      await deleteLabel(id);
    });
  });

  content.querySelector('#create-label-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value;
    const color = form.elements.color.value;
    await createLabel(name, color);
    form.reset();
  });

  content.querySelector('#close-label-manager-btn').addEventListener('click', () => {
    document.getElementById('label-manager-dialog').close();
  });
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    for (const id of selectedLabelIds) {
      if (cardLabelIds.has(id)) return true;
    }
    return false;
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
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const unassignedLabels = labels.filter(l => !cardLabels.some(cl => cl.id === l.id));

  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(l => \`
          <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">
            \${escapeHtml(l.name)}
            <button class="remove-label-btn" data-label-id="\${escapeHtml(l.id)}">&times;</button>
          </span>
        \`).join('')}
        \${unassignedLabels.length > 0 ? \`
          <div class="add-label-dropdown">
            <button class="add-label-btn">+</button>
            <div class="dropdown-content">
              \${unassignedLabels.map(l => \`
                <button class="assign-label-btn" data-label-id="\${escapeHtml(l.id)}">
                  <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
                </button>
              \`).join('')}
            </div>
          </div>
        \` : ''}
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
    </article>
  \`;
}

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

function bindEvents() {
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      const columnId = form.dataset.columnId;
      input.value = '';
      await createCard(columnId, text);
    });
  });

  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (event) => {
      if (event.target.closest('button')) {
        event.preventDefault();
        return;
      }
      draggedCardId = card.dataset.cardId;
      card.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      draggedCardId = null;
      card.classList.remove('dragging');
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });

    card.querySelectorAll('.remove-label-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const labelId = btn.dataset.labelId;
        const cardId = card.dataset.cardId;
        await unassignLabel(cardId, labelId);
      });
    });

    card.querySelectorAll('.assign-label-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const labelId = btn.dataset.labelId;
        const cardId = card.dataset.cardId;
        await assignLabel(cardId, labelId);
      });
    });
  });

  document.querySelectorAll('.cards').forEach((container) => {
    container.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (!draggedCardId) return;
      container.classList.add('drop-target');
      const afterElement = getDragAfterElement(container, event.clientY);
      const draggable = document.querySelector('.dragging');
      if (afterElement == null) {
        container.appendChild(draggable);
      } else {
        container.insertBefore(draggable, afterElement);
      }
    });
    container.addEventListener('dragleave', (event) => {
      if (!container.contains(event.relatedTarget)) {
        container.classList.remove('drop-target');
      }
    });
    container.addEventListener('drop', async (event) => {
      event.preventDefault();
      container.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = container.dataset.columnId;
      const { beforeId, afterId } = getDropPosition(container, draggedCardId);
      const cardId = draggedCardId;
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${cardId}/move\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(\`Move failed: \${error.message}\`, true);
        await loadBoard();
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        return { offset: offset, element: child };
      } else {
        return closest;
      }
    },
    { offset: Number.NEGATIVE_INFINITY }
  ).element;
}

function getDropPosition(container, cardId) {
  const list = container.closest('.column').querySelector('.cards');
  const ids = [...list.querySelectorAll('.card')].map((el) => el.dataset.cardId);
  const index = ids.indexOf(cardId);
  return {
    afterId: index > 0 ? ids[index - 1] : null,
    beforeId: index >= 0 && index < ids.length - 1 ? ids[index + 1] : null,
  };
}

function optimisticMove(cardId, columnId, beforeId, afterId) {
  const existing = removeCardEverywhere(cardId);
  if (!existing) return;
  const target = board.columns.find((column) => column.id === columnId);
  if (!target) return;
  const afterIndex = afterId ? target.cards.findIndex((card) => card.id === afterId) : -1;
  const beforeIndex = beforeId ? target.cards.findIndex((card) => card.id === beforeId) : -1;
  let insertAt = target.cards.length;
  if (afterIndex !== -1) insertAt = afterIndex + 1;
  else if (beforeIndex !== -1) insertAt = beforeIndex;
  target.cards.splice(insertAt, 0, { ...existing, column_id: columnId, optimistic: true });
}

async function createCard(columnId, text) {
  try {
    const response = await fetch(\`\${API_BASE}/api/cards\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(\`Create failed: \${error.message}\`, true);
  }
}

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
    }
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    
    // Remove label from cards
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
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    const card = message.card;
    if (card) {
      const existing = findCard(card.id);
      if (existing) {
        existing.card.labels = card.labels;
        render();
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

async function loadBoard() {
  const response = await fetch(\`\${API_BASE}/api/board\`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
}

async function loadLabels() {
  const response = await fetch(\`\${API_BASE}/api/labels\`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(\`\${API_BASE}/api/stream\`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.onerror = () => setStatus('Reconnecting…', true);
}

function setStatus(text, warn = false) {
  const status = document.querySelector('#status');
  if (status) {
    status.textContent = text;
    status.classList.toggle('warn', warn);
  }
  clearTimeout(statusTimer);
  if (warn) {
    statusTimer = setTimeout(() => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'), 4000);
  }
}

async function start() {
  app.innerHTML = '<div class="loading">Loading board…</div>';
  try {
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}

start();
`;

fs.writeFileSync(filePath, newContent, 'utf8');
console.log('Replaced successfully');
