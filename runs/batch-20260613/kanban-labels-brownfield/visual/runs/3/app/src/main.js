import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────────

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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
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
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '';
  const chips = labels.map((label) => {
    const active = activeFilters.has(label.id);
    return `<button
      class="filter-chip${active ? ' active' : ''}"
      data-filter-label-id="${escapeHtml(label.id)}"
      style="--chip-color:${escapeHtml(label.color)}"
      title="Filter by ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');
  const clearBtn = activeFilters.size > 0
    ? `<button class="filter-clear" id="filter-clear-btn">Clear filter</button>`
    : '';
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${chips}
      ${clearBtn}
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
        ${column.cards.map((card) => renderCard(card, cardMatchesFilter(card))).join('')}
      </div>
    </section>
  `;
}

function renderCard(card, visible = true) {
  const labelChips = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');

  const assignableLabels = labels.map((label) => {
    const assigned = (card.labels || []).some((l) => l.id === label.id);
    return `<button
      class="label-assign-btn${assigned ? ' assigned' : ''}"
      data-card-id="${escapeHtml(card.id)}"
      data-label-id="${escapeHtml(label.id)}"
      data-assigned="${assigned}"
      style="--chip-color:${escapeHtml(label.color)}"
      title="${assigned ? 'Remove' : 'Assign'} label ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');

  const labelSection = labels.length > 0
    ? `<div class="card-label-section">
        <div class="card-label-chips">${labelChips}</div>
        <details class="card-label-picker">
          <summary class="card-label-picker-toggle">Labels ▾</summary>
          <div class="card-label-picker-list">${assignableLabels}</div>
        </details>
      </div>`
    : (card.labels && card.labels.length > 0
        ? `<div class="card-label-chips">${labelChips}</div>`
        : '');

  return `
    <article
      class="card${visible ? '' : ' hidden-by-filter'}"
      draggable="true"
      data-card-id="${escapeHtml(card.id)}"
      title="Drag to move"
    >
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelSection}
    </article>
  `;
}

function renderLabelManager() {
  const rows = labels.map((label) => `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-name-display">${escapeHtml(label.name)}</span>
      <input class="label-edit-name" type="text" value="${escapeHtml(label.name)}" maxlength="50" style="display:none" />
      <input class="label-edit-color" type="color" value="${escapeHtml(label.color)}" style="display:none" />
      <button class="label-btn label-edit-btn" data-label-id="${escapeHtml(label.id)}">Edit</button>
      <button class="label-btn label-save-btn" data-label-id="${escapeHtml(label.id)}" style="display:none">Save</button>
      <button class="label-btn label-cancel-btn" data-label-id="${escapeHtml(label.id)}" style="display:none">Cancel</button>
      <button class="label-btn label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </li>
  `).join('');

  return `
    <aside class="label-manager">
      <h2 class="label-manager-title">Labels</h2>
      <ul class="label-list">${rows}</ul>
      <form class="label-create-form" id="label-create-form">
        <input class="label-create-name" name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
        <input class="label-create-color" name="color" type="color" value="#3b82f6" />
        <button type="submit" class="label-btn label-create-btn">Create</button>
      </form>
      <div class="label-manager-error" id="label-manager-error"></div>
    </aside>
  `;
}

// ── Event binding ──────────────────────────────────────────────────────────────

function bindEvents() {
  // Add-card forms
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

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbors(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilters.has(id)) {
        activeFilters.delete(id);
      } else {
        activeFilters.add(id);
      }
      render();
    });
  });

  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Label assign/unassign buttons on cards
  document.querySelectorAll('.label-assign-btn').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const { cardId, labelId, assigned } = btn.dataset;
      if (assigned === 'true') {
        await unassignLabel(cardId, labelId);
      } else {
        await assignLabel(cardId, labelId);
      }
    });
  });

  // Label manager: create
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      const err = await createLabel(name, color);
      const errEl = document.getElementById('label-manager-error');
      if (errEl) errEl.textContent = err || '';
      if (!err) createForm.elements.name.value = '';
    });
  }

  // Label manager: edit / save / cancel / delete
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = document.querySelector(`.label-row[data-label-id="${btn.dataset.labelId}"]`);
      if (!row) return;
      row.querySelector('.label-name-display').style.display = 'none';
      row.querySelector('.label-swatch').style.display = 'none';
      row.querySelector('.label-edit-name').style.display = '';
      row.querySelector('.label-edit-color').style.display = '';
      row.querySelector('.label-edit-btn').style.display = 'none';
      row.querySelector('.label-save-btn').style.display = '';
      row.querySelector('.label-cancel-btn').style.display = '';
    });
  });

  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = document.querySelector(`.label-row[data-label-id="${btn.dataset.labelId}"]`);
      if (!row) return;
      const name = row.querySelector('.label-edit-name').value.trim();
      const color = row.querySelector('.label-edit-color').value;
      const errEl = document.getElementById('label-manager-error');
      const err = await updateLabel(btn.dataset.labelId, name, color);
      if (errEl) errEl.textContent = err || '';
    });
  });

  document.querySelectorAll('.label-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      render(); // re-render to reset edit state
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const errEl = document.getElementById('label-manager-error');
      const err = await deleteLabel(btn.dataset.labelId);
      if (errEl) errEl.textContent = err || '';
    });
  });
}

// ── Drag helpers ───────────────────────────────────────────────────────────────

function getDropNeighbors(list, cardId) {
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

// ── API calls ──────────────────────────────────────────────────────────────────

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
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/move`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columnId, beforeId, afterId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
  } catch (error) {
    setStatus(`Move failed: ${error.message}`, true);
  }
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const data = await response.json();
      return data.error || 'Create failed';
    }
    return null;
  } catch (error) {
    return error.message;
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
      const data = await response.json();
      return data.error || 'Update failed';
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const data = await response.json();
      return data.error || 'Delete failed';
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ── SSE / state application ────────────────────────────────────────────────────

function applyMutation(message) {
  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

function applyLabelEvent(message) {
  switch (message.type) {
    case 'label-created':
      if (message.label && !labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    case 'label-updated':
      if (message.label) {
        const idx = labels.findIndex((l) => l.id === message.label.id);
        if (idx !== -1) labels[idx] = message.label;
        else labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      if (message.board) board = normalizeBoard(message.board);
      break;
    case 'label-deleted':
      if (message.labelId) {
        labels = labels.filter((l) => l.id !== message.labelId);
        activeFilters.delete(message.labelId);
      }
      if (message.board) board = normalizeBoard(message.board);
      break;
    case 'card-label-assigned':
    case 'card-label-unassigned':
      if (message.card) {
        const card = { ...message.card, labels: message.card.labels || [] };
        removeCardEverywhere(card.id);
        const target = board.columns.find((col) => col.id === card.column_id);
        if (target) {
          target.cards.push(card);
          target.cards.sort(compareCards);
        }
      }
      if (message.board) board = normalizeBoard(message.board);
      break;
  }
  render();
  setStatus('Synced');
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

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.addEventListener('label', (event) => {
    applyLabelEvent(JSON.parse(event.data));
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
