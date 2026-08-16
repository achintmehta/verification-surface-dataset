import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let selectedFilterLabels = new Set();
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

function cardMatchesFilter(card) {
  if (selectedFilterLabels.size === 0) return true;
  if (!card.labels || card.labels.length === 0) return false;
  return card.labels.some((label) => selectedFilterLabels.has(label.id));
}

function render() {
  const filteredColumns = board.columns.map((column) => ({
    ...column,
    cards: column.cards.filter(cardMatchesFilter),
  }));

  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    <div class="filter-bar">
      <label>Filter by labels:</label>
      <select id="filter-select" multiple size="3">
        ${labels.map(l => `<option value="${escapeHtml(l.id)}" ${selectedFilterLabels.has(l.id) ? 'selected' : ''}>${escapeHtml(l.name)}</option>`).join('')}
      </select>
      <button id="clear-filter">Clear</button>
    </div>
    <div class="label-manager">
      <h3>Labels</h3>
      <div class="label-list" id="label-list">
        ${labels.map(renderLabelItem).join('')}
      </div>
      <form class="label-form" id="create-label-form">
        <input type="text" name="name" placeholder="New label name" required maxlength="50" />
        <input type="color" name="color" value="#3b82f6" />
        <button type="submit">Create</button>
      </form>
    </div>
    <main class="board">
      ${filteredColumns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
  bindLabelEvents();
}

function renderLabelItem(label) {
  return `
    <div class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-chip" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
      <button class="edit-label" data-action="rename">Rename</button>
      <button class="edit-label" data-action="recolor">Recolor</button>
      <button class="edit-label" data-action="delete">Delete</button>
    </div>
  `;
}

function renderColumn(column) {
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const chips = (card.labels || []).map(label => 
    `<span class="label-chip" style="background: ${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}<span class="remove" data-action="remove-label" data-label-id="${escapeHtml(label.id)}">×</span></span>`
  ).join('');
  const labelOptions = labels.map(l => `<option value="${escapeHtml(l.id)}">${escapeHtml(l.name)}</option>`).join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${escapeHtml(card.text)}
      <div class="card-labels">${chips}</div>
      <div class="label-assign">
        <select class="assign-label" data-card-id="${escapeHtml(card.id)}">
          <option value="">+ Add label</option>
          ${labelOptions}
        </select>
      </div>
    </article>
  `;
}

function bindEvents() {
  // existing add card, drag etc.
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const columnId = form.dataset.columnId;
      if (input.value.trim()) {
        await createCard(columnId, input.value);
        input.value = '';
      }
    });
  });

  // Drag and drop
  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (e) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      document.querySelectorAll('.cards').forEach((c) => c.classList.remove('drop-target'));
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((cardsEl) => {
    cardsEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      cardsEl.classList.add('drop-target');
    });
    cardsEl.addEventListener('dragleave', () => {
      cardsEl.classList.remove('drop-target');
    });
    cardsEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      cardsEl.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = cardsEl.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(cardsEl, e.clientY);
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Label remove from chip
  document.querySelectorAll('.remove[data-action="remove-label"]').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopImmediatePropagation();
      const cardEl = el.closest('.card');
      const cardId = cardEl.dataset.cardId;
      const labelId = el.dataset.labelId;
      await unassignLabel(cardId, labelId);
    });
  });

  // Assign label select
  document.querySelectorAll('.assign-label').forEach((select) => {
    select.addEventListener('change', async () => {
      const cardId = select.dataset.cardId;
      const labelId = select.value;
      if (labelId) {
        await assignLabel(cardId, labelId);
        select.value = '';
      }
    });
  });
}

function bindLabelEvents() {
  // Filter
  const filterSelect = document.getElementById('filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', () => {
      selectedFilterLabels = new Set(Array.from(filterSelect.selectedOptions).map(o => o.value));
      render();
    });
  }
  const clearBtn = document.getElementById('clear-filter');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      selectedFilterLabels.clear();
      render();
    });
  }

  // Create label
  const createForm = document.getElementById('create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const nameInput = createForm.elements.name;
      const colorInput = createForm.elements.color;
      await createLabel(nameInput.value, colorInput.value);
      nameInput.value = '';
    });
  }

  // Edit labels
  document.querySelectorAll('.edit-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const item = btn.closest('.label-item');
      const labelId = item.dataset.labelId;
      const action = btn.dataset.action;
      const label = labels.find(l => l.id === labelId);
      if (!label) return;

      if (action === 'delete') {
        if (confirm(`Delete label "${label.name}"?`)) {
          await deleteLabel(labelId);
        }
      } else if (action === 'rename') {
        const newName = prompt('New name:', label.name);
        if (newName && newName.trim()) {
          await updateLabel(labelId, newName.trim(), label.color);
        }
      } else if (action === 'recolor') {
        const newColor = prompt('New color hex:', label.color);
        if (newColor && /^#[0-9a-fA-F]{6}$/.test(newColor)) {
          await updateLabel(labelId, label.name, newColor);
        }
      }
    });
  });
}

function getDropPosition(list, clientY) {
  const cards = Array.from(list.querySelectorAll('.card:not(.dragging)'));
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) {
      return { afterId: null, beforeId: card.dataset.cardId };
    }
  }
  const last = cards[cards.length - 1];
  return {
    afterId: last ? last.dataset.cardId : null,
    beforeId: null,
  };
}

function getSiblingIds(list, cardId) {
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
    const response = await fetch(`${API_BASE}/api/cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, text }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
  } catch (error) {
    setStatus(`Create failed: ${error.message}`, true);
  }
}

async function moveCard(cardId, columnId, beforeId, afterId) {
  try {
    optimisticMove(cardId, columnId, beforeId, afterId);
    render();
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Create label failed');
    }
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Update label failed');
    }
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Delete label failed');
    }
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Assign failed');
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  const type = message.type;
  if (type && type.startsWith('label-')) {
    // For label changes, reload board and labels to sync
    loadBoard().then(() => {
      loadLabels().then(() => {
        render();
        setStatus('Synced');
      });
    }).catch(() => {});
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

async function loadAll() {
  await loadBoard();
  await loadLabels();
  render();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
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
    await loadAll();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
