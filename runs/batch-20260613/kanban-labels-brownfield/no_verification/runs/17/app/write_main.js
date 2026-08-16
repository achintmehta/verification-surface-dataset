import fs from 'fs';

const mainJs = `import './style.css';

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
  app.innerHTML = \`
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="controls">
        <div id="filter-bar">
          \${labels.map(l => \`
            <label class="filter-label">
              <input type="checkbox" class="filter-checkbox" data-label-id="\${escapeHtml(l.id)}" \${selectedLabelIds.has(l.id) ? 'checked' : ''}>
              <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
            </label>
          \`).join('')}
          \${selectedLabelIds.size > 0 ? \`<button id="clear-filter-btn">Clear Filter</button>\` : ''}
        </div>
        <button id="manage-labels-btn">Manage Labels</button>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <main class="board">
      \${board.columns.map(renderColumn).join('')}
    </main>
    <div id="modal-container"></div>
  \`;
  bindEvents();
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabelIds.size === 0) return true;
    const cardLabelIds = (card.labels || []).map(l => l.id);
    return cardLabelIds.some(id => selectedLabelIds.has(id));
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
  return \`
    <article class="card" draggable="true" data-card-id="\${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        \${cardLabels.map(l => \`<span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>\`).join('')}
        <button class="edit-card-labels-btn" data-card-id="\${escapeHtml(card.id)}">🏷️</button>
      </div>
      <div class="card-text">\${escapeHtml(card.text)}</div>
    </article>
  \`;
}

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

  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const labelId = e.target.dataset.labelId;
      if (e.target.checked) {
        selectedLabelIds.add(labelId);
      } else {
        selectedLabelIds.delete(labelId);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter-btn');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabelIds.clear();
      render();
    });
  }

  const manageLabelsBtn = document.getElementById('manage-labels-btn');
  if (manageLabelsBtn) {
    manageLabelsBtn.addEventListener('click', openLabelManager);
  }

  document.querySelectorAll('.edit-card-labels-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelManager(btn.dataset.cardId);
    });
  });
}

function openLabelManager() {
  const modalContainer = document.getElementById('modal-container');
  modalContainer.innerHTML = \`
    <div class="modal-overlay">
      <div class="modal">
        <h2>Manage Labels</h2>
        <ul class="label-list">
          \${labels.map(l => \`
            <li>
              <form class="edit-label-form" data-label-id="\${escapeHtml(l.id)}">
                <input type="color" name="color" value="\${escapeHtml(l.color)}" required>
                <input type="text" name="name" value="\${escapeHtml(l.name)}" required>
                <button type="submit">Save</button>
                <button type="button" class="delete-label-btn" data-label-id="\${escapeHtml(l.id)}">Delete</button>
              </form>
            </li>
          \`).join('')}
        </ul>
        <h3>Create New Label</h3>
        <form id="create-label-form">
          <input type="color" name="color" value="#ff0000" required>
          <input type="text" name="name" placeholder="Label name" required>
          <button type="submit">Create</button>
        </form>
        <button class="close-modal-btn">Close</button>
      </div>
    </div>
  \`;

  document.getElementById('create-label-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    try {
      const res = await fetch(\`\${API_BASE}/api/labels\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to create label');
      openLabelManager(); // re-render modal
    } catch (err) {
      alert(err.message);
    }
  });

  document.querySelectorAll('.edit-label-form').forEach(form => {
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
        openLabelManager();
      } catch (err) {
        alert(err.message);
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
        openLabelManager();
      } catch (err) {
        alert(err.message);
      }
    });
  });

  document.querySelector('.close-modal-btn').addEventListener('click', () => {
    modalContainer.innerHTML = '';
  });
}

function openCardLabelManager(cardId) {
  const cardMatch = findCard(cardId);
  if (!cardMatch) return;
  const card = cardMatch.card;
  const cardLabelIds = new Set((card.labels || []).map(l => l.id));

  const modalContainer = document.getElementById('modal-container');
  modalContainer.innerHTML = \`
    <div class="modal-overlay">
      <div class="modal">
        <h2>Labels for Card</h2>
        <ul class="card-label-list">
          \${labels.map(l => \`
            <li>
              <label>
                <input type="checkbox" class="toggle-card-label" data-card-id="\${escapeHtml(cardId)}" data-label-id="\${escapeHtml(l.id)}" \${cardLabelIds.has(l.id) ? 'checked' : ''}>
                <span class="label-chip" style="background-color: \${escapeHtml(l.color)}">\${escapeHtml(l.name)}</span>
              </label>
            </li>
          \`).join('')}
        </ul>
        <button class="close-modal-btn">Close</button>
      </div>
    </div>
  \`;

  document.querySelectorAll('.toggle-card-label').forEach(cb => {
    cb.addEventListener('change', async (e) => {
      const labelId = e.target.dataset.labelId;
      const isChecked = e.target.checked;
      try {
        if (isChecked) {
          const res = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels\`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ labelId })
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Failed to assign label');
        } else {
          const res = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels/\${encodeURIComponent(labelId)}\`, {
            method: 'DELETE'
          });
          if (!res.ok) throw new Error((await res.json()).error || 'Failed to unassign label');
        }
      } catch (err) {
        alert(err.message);
        e.target.checked = !isChecked; // revert
      }
    });
  });

  document.querySelector('.close-modal-btn').addEventListener('click', () => {
    modalContainer.innerHTML = '';
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getNeighborsFromDom(list, cardId) {
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
  if (message.type === 'create_label') {
    labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    render();
    if (document.querySelector('.modal h2')?.textContent === 'Manage Labels') openLabelManager();
    if (document.querySelector('.modal h2')?.textContent === 'Labels for Card') {
      const cardId = document.querySelector('.toggle-card-label')?.dataset.cardId;
      if (cardId) openCardLabelManager(cardId);
    }
    return;
  }
  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) labels[index] = message.label;
    labels.sort((a, b) => a.name.localeCompare(b.name));
    for (const col of board.columns) {
      for (const card of col.cards) {
        const lIndex = card.labels?.findIndex(l => l.id === message.label.id);
        if (lIndex !== -1 && lIndex !== undefined) {
          card.labels[lIndex] = message.label;
        }
      }
    }
    render();
    if (document.querySelector('.modal h2')?.textContent === 'Manage Labels') openLabelManager();
    if (document.querySelector('.modal h2')?.textContent === 'Labels for Card') {
      const cardId = document.querySelector('.toggle-card-label')?.dataset.cardId;
      if (cardId) openCardLabelManager(cardId);
    }
    return;
  }
  if (message.type === 'delete_label') {
    labels = labels.filter(l => l.id !== message.labelId);
    selectedLabelIds.delete(message.labelId);
    for (const col of board.columns) {
      for (const card of col.cards) {
        if (card.labels) {
          card.labels = card.labels.filter(l => l.id !== message.labelId);
        }
      }
    }
    render();
    if (document.querySelector('.modal h2')?.textContent === 'Manage Labels') openLabelManager();
    if (document.querySelector('.modal h2')?.textContent === 'Labels for Card') {
      const cardId = document.querySelector('.toggle-card-label')?.dataset.cardId;
      if (cardId) openCardLabelManager(cardId);
    }
    return;
  }
  if (message.type === 'assign_label' || message.type === 'unassign_label') {
    const card = message.card;
    const existing = findCard(card.id);
    if (existing) {
      existing.card.labels = card.labels;
      render();
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

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(\`\${API_BASE}/api/board\`),
    fetch(\`\${API_BASE}/api/labels\`)
  ]);
  if (!boardRes.ok || !labelsRes.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
  render();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = \`<div class="loading error">\${escapeHtml(error.message)}</div>\`;
  }
}

start();
`;

fs.writeFileSync('src/main.js', mainJs);
