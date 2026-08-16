import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ─────────────────────────────────────────────────────────────────

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

// ── Filtering ─────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ────────────────────────────────────────────────────────────────────

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
  if (labels.length === 0) return '<div class="filter-bar" id="filter-bar"></div>';
  return `
    <div class="filter-bar" id="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${labels.map((label) => {
        const active = activeFilters.has(label.id);
        return `<button
          class="filter-chip${active ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color:${escapeHtml(label.color)}"
          title="Filter by ${escapeHtml(label.name)}"
        >${escapeHtml(label.name)}</button>`;
      }).join('')}
      ${activeFilters.size > 0 ? `<button class="filter-clear" id="filter-clear">Clear filter</button>` : ''}
      <button class="manage-labels-btn" id="open-label-manager">Manage Labels</button>
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const chipsHtml = cardLabels.map((label) => `
    <span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>
  `).join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length > 0 ? `<div class="card-labels">${chipsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ───────────────────────────────────────────────────────

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay" style="display:none">
      <div class="modal" id="label-manager">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
            <input name="color" type="color" value="#3b82f6" title="Label color" />
            <button type="submit">Create</button>
          </form>
          <ul class="label-list" id="label-list">
            ${renderLabelList()}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderLabelList() {
  if (labels.length === 0) return '<li class="label-list-empty">No labels yet.</li>';
  return labels.map((label) => `
    <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-name-display">${escapeHtml(label.name)}</span>
      <input class="label-name-edit" type="text" value="${escapeHtml(label.name)}" maxlength="50" style="display:none" />
      <input class="label-color-edit" type="color" value="${escapeHtml(label.color)}" style="display:none" />
      <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}">Edit</button>
      <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}" style="display:none">Save</button>
      <button class="label-cancel-btn" data-label-id="${escapeHtml(label.id)}" style="display:none">Cancel</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </li>
  `).join('');
}

// ── Card Label Assignment Modal ───────────────────────────────────────────────

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  const items = labels.map((label) => {
    const assigned = cardLabelIds.has(label.id);
    return `
      <li class="card-label-item">
        <label>
          <input type="checkbox" class="card-label-checkbox"
            data-card-id="${escapeHtml(card.id)}"
            data-label-id="${escapeHtml(label.id)}"
            ${assigned ? 'checked' : ''} />
          <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </label>
      </li>
    `;
  }).join('');

  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal modal-sm" id="card-label-modal">
        <div class="modal-header">
          <h2>Labels for card</h2>
          <button class="modal-close" id="close-card-label-modal">✕</button>
        </div>
        <div class="modal-body">
          ${labels.length === 0
            ? '<p class="label-list-empty">No labels yet. Create some in Manage Labels.</p>'
            : `<ul class="card-label-list">${items}</ul>`
          }
        </div>
      </div>
    </div>
  `;
}

function openCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const existing = document.getElementById('card-label-overlay');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.innerHTML = renderCardLabelModal(found.card);
  document.body.appendChild(div.firstElementChild);
  bindCardLabelModalEvents(cardId);
}

function bindCardLabelModalEvents(cardId) {
  const overlay = document.getElementById('card-label-overlay');
  if (!overlay) return;

  document.getElementById('close-card-label-modal').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const { cardId: cid, labelId } = checkbox.dataset;
      if (checkbox.checked) {
        await assignLabel(cid, labelId);
      } else {
        await unassignLabel(cid, labelId);
      }
    });
  });
}

// ── Event Binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.disabled = true;
      await createCard(form.dataset.columnId, text);
      input.disabled = false;
      input.focus();
    });
  });

  // Drag-and-drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drop-target');
    });
    zone.addEventListener('dragleave', (e) => {
      if (!zone.contains(e.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getDropNeighbors(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.filterLabelId;
      if (activeFilters.has(labelId)) {
        activeFilters.delete(labelId);
      } else {
        activeFilters.add(labelId);
      }
      render();
    });
  });

  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Open label manager
  const openManagerBtn = document.getElementById('open-label-manager');
  if (openManagerBtn) {
    openManagerBtn.addEventListener('click', () => {
      const overlay = document.getElementById('label-manager-overlay');
      if (overlay) overlay.style.display = 'flex';
    });
  }

  // Close label manager
  const closeManagerBtn = document.getElementById('close-label-manager');
  if (closeManagerBtn) {
    closeManagerBtn.addEventListener('click', () => {
      const overlay = document.getElementById('label-manager-overlay');
      if (overlay) overlay.style.display = 'none';
    });
  }

  const managerOverlay = document.getElementById('label-manager-overlay');
  if (managerOverlay) {
    managerOverlay.addEventListener('click', (e) => {
      if (e.target === managerOverlay) managerOverlay.style.display = 'none';
    });
  }

  // Create label form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      const ok = await createLabel(name, color);
      if (ok) {
        createForm.elements.name.value = '';
        createForm.elements.color.value = '#3b82f6';
      }
    });
  }

  // Label list edit/save/cancel/delete
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('.label-list-item');
      li.querySelector('.label-name-display').style.display = 'none';
      li.querySelector('.label-name-edit').style.display = '';
      li.querySelector('.label-color-edit').style.display = '';
      btn.style.display = 'none';
      li.querySelector('.label-save-btn').style.display = '';
      li.querySelector('.label-cancel-btn').style.display = '';
      li.querySelector('.label-delete-btn').style.display = 'none';
    });
  });

  document.querySelectorAll('.label-cancel-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const li = btn.closest('.label-list-item');
      const labelId = li.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (label) {
        li.querySelector('.label-name-edit').value = label.name;
        li.querySelector('.label-color-edit').value = label.color;
      }
      li.querySelector('.label-name-display').style.display = '';
      li.querySelector('.label-name-edit').style.display = 'none';
      li.querySelector('.label-color-edit').style.display = 'none';
      li.querySelector('.label-edit-btn').style.display = '';
      btn.style.display = 'none';
      li.querySelector('.label-save-btn').style.display = 'none';
      li.querySelector('.label-delete-btn').style.display = '';
    });
  });

  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const li = btn.closest('.label-list-item');
      const labelId = li.dataset.labelId;
      const name = li.querySelector('.label-name-edit').value.trim();
      const color = li.querySelector('.label-color-edit').value;
      if (!name) { setStatus('Label name cannot be empty', true); return; }
      await updateLabel(labelId, name, color);
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = labels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      await deleteLabel(labelId);
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelModal(btn.dataset.cardId);
    });
  });
}

// ── Drag helpers ──────────────────────────────────────────────────────────────

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

// ── API calls ─────────────────────────────────────────────────────────────────

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
      const err = await response.json();
      setStatus(`Create label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Create label failed: ${error.message}`, true);
    return false;
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
      setStatus(`Update label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Update label failed: ${error.message}`, true);
    return false;
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Delete label failed: ${err.error}`, true);
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Delete label failed: ${error.message}`, true);
    return false;
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
      setStatus(`Assign label failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Assign label failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Unassign label failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Unassign label failed: ${error.message}`, true);
  }
}

// ── SSE / mutation handling ───────────────────────────────────────────────────

function applyMutation(message) {
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

function applyLabelEvent(message) {
  const { type } = message;

  if (type === 'label-created') {
    const { label } = message;
    if (!labels.find((l) => l.id === label.id)) {
      labels.push(label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-updated') {
    const { label } = message;
    const idx = labels.findIndex((l) => l.id === label.id);
    if (idx !== -1) labels[idx] = label;
    else labels.push(label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-deleted') {
    const { labelId } = message;
    labels = labels.filter((l) => l.id !== labelId);
    activeFilters.delete(labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-assigned' || type === 'label-unassigned') {
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
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
