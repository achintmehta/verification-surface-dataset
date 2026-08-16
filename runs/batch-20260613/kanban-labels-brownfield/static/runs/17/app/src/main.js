import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedLabels = new Set();
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
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="labels-section">
      <div class="label-manager">
        <h3>Labels</h3>
        <form id="add-label-form">
          <input type="text" name="name" placeholder="Label name" required />
          <input type="color" name="color" value="#ff0000" required />
          <button type="submit">Add Label</button>
        </form>
        <div class="label-list">
          ${labels.map(renderLabelItem).join('')}
        </div>
      </div>
      <div class="label-filter">
        <h3>Filter by Labels</h3>
        <div class="filter-list">
          ${labels.map(renderFilterItem).join('')}
        </div>
        <button id="clear-filter">Clear Filter</button>
      </div>
    </div>
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-color" style="background-color: ${escapeHtml(label.color)}"></span>
      <span class="label-name">${escapeHtml(label.name)}</span>
      <button class="edit-label">Edit</button>
      <button class="delete-label">Delete</button>
    </div>
  `;
}

function renderFilterItem(label) {
  const isSelected = selectedLabels.has(label.id);
  return `
    <label class="filter-item">
      <input type="checkbox" value="${escapeHtml(label.id)}" ${isSelected ? 'checked' : ''} class="filter-checkbox" />
      <span class="label-color" style="background-color: ${escapeHtml(label.color)}"></span>
      ${escapeHtml(label.name)}
    </label>
  `;
}

function renderColumn(column) {
  const filteredCards = column.cards.filter(card => {
    if (selectedLabels.size === 0) return true;
    const cardLabelIds = new Set((card.labels || []).map(l => l.id));
    for (const selectedId of selectedLabels) {
      if (cardLabelIds.has(selectedId)) return true;
    }
    return false;
  });

  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${filteredCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">
        ${(card.labels || []).map(l => `<span class="card-label" style="background-color: ${escapeHtml(l.color)}" title="${escapeHtml(l.name)}"></span>`).join('')}
      </div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-actions">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">Assign label...</option>
          ${labels.filter(l => !(card.labels || []).some(cl => cl.id === l.id)).map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('')}
        </select>
        <div class="assigned-labels">
          ${(card.labels || []).map(l => `
            <span class="assigned-label" style="background-color: ${escapeHtml(l.color)}">
              ${escapeHtml(l.name)}
              <button class="unassign-label" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(l.id)}">&times;</button>
            </span>
          `).join('')}
        </div>
      </div>
    </article>
  `;
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

  const addLabelForm = document.getElementById('add-label-form');
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
        if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
        addLabelForm.reset();
      } catch (error) {
        setStatus(\`Create label failed: \${error.message}\`, true);
      }
    });
  }

  document.querySelectorAll('.delete-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelId = e.target.closest('.label-item').dataset.labelId;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'DELETE'
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
      } catch (error) {
        setStatus(\`Delete label failed: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.edit-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const labelItem = e.target.closest('.label-item');
      const labelId = labelItem.dataset.labelId;
      const label = labels.find(l => l.id === labelId);
      if (!label) return;
      const newName = prompt('New name:', label.name);
      if (newName === null) return;
      const newColor = prompt('New color (hex):', label.color);
      if (newColor === null) return;
      try {
        const response = await fetch(\`\${API_BASE}/api/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: newName.trim(), color: newColor }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Edit label failed');
      } catch (error) {
        setStatus(\`Edit label failed: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.filter-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        selectedLabels.add(e.target.value);
      } else {
        selectedLabels.delete(e.target.value);
      }
      render();
    });
  });

  const clearFilterBtn = document.getElementById('clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      selectedLabels.clear();
      render();
    });
  }

  document.querySelectorAll('.assign-label').forEach(select => {
    select.addEventListener('change', async (e) => {
      const labelId = e.target.value;
      if (!labelId) return;
      const cardId = e.target.dataset.cardId;
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ labelId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Assign label failed');
      } catch (error) {
        setStatus(\`Assign label failed: \${error.message}\`, true);
      }
    });
  });

  document.querySelectorAll('.unassign-label').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const cardId = e.target.dataset.cardId;
      const labelId = e.target.dataset.labelId;
      try {
        const response = await fetch(\`\${API_BASE}/api/cards/\${encodeURIComponent(cardId)}/labels/\${encodeURIComponent(labelId)}\`, {
          method: 'DELETE'
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Unassign label failed');
      } catch (error) {
        setStatus(\`Unassign label failed: \${error.message}\`, true);
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
    return;
  }
  if (message.type === 'update_label') {
    const index = labels.findIndex(l => l.id === message.label.id);
    if (index !== -1) {
      labels[index] = message.label;
      labels.sort((a, b) => a.name.localeCompare(b.name));
      // Update label in cards
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
  if (!boardRes.ok || !labelsRes.ok) throw new Error('Could not load board or labels');
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
