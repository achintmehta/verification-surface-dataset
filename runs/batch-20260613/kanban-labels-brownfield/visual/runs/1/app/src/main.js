import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // [{id, name, color}, …]
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ────────────────────────────────────────────────────────────────

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

/** Returns true if the card passes the current label filter. */
function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ───────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderLabelBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderLabelBar() {
  const filterChips = allLabels.map((label) => {
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
    <div class="label-bar">
      <div class="label-bar-filters">
        <span class="label-bar-title">Filter:</span>
        ${filterChips || '<span class="label-bar-empty">No labels yet</span>'}
        ${clearBtn}
      </div>
      <button class="manage-labels-btn" id="open-label-manager">Manage Labels</button>
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
        ${column.cards.map((card) => renderCard(card)).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const visible = cardMatchesFilter(card);
  const labelsHtml = (card.labels || []).map((label) => `
    <span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>
  `).join('');

  return `
    <article
      class="card${visible ? '' : ' card-hidden'}"
      draggable="true"
      data-card-id="${escapeHtml(card.id)}"
      title="Drag to move"
    >
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml ? `<div class="card-labels">${labelsHtml}</div>` : ''}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Assign labels">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ──────────────────────────────────────────────────────

function renderLabelManagerModal() {
  const rows = allLabels.map((label) => `
    <li class="lm-row" data-label-id="${escapeHtml(label.id)}">
      <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="lm-name">${escapeHtml(label.name)}</span>
      <button class="lm-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
      <button class="lm-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
    </li>
  `).join('');

  return `
    <div class="modal-backdrop hidden" id="label-manager-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Label Manager">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <ul class="lm-list">${rows || '<li class="lm-empty">No labels yet.</li>'}</ul>
        <form class="lm-create-form" id="lm-create-form">
          <input name="name" type="text" maxlength="60" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" title="Pick a color" />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
    <div class="modal-backdrop hidden" id="label-edit-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Edit Label">
        <div class="modal-header">
          <h2>Edit Label</h2>
          <button class="modal-close" id="close-label-edit">✕</button>
        </div>
        <form class="lm-edit-form" id="lm-edit-form">
          <input type="hidden" name="id" />
          <input name="name" type="text" maxlength="60" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" title="Pick a color" />
          <button type="submit">Save</button>
        </form>
      </div>
    </div>
    <div class="modal-backdrop hidden" id="card-label-modal">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Assign Labels">
        <div class="modal-header">
          <h2>Assign Labels</h2>
          <button class="modal-close" id="close-card-label">✕</button>
        </div>
        <div id="card-label-list"></div>
      </div>
    </div>
  `;
}

// ── Event binding ────────────────────────────────────────────────────────────

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

  // Label filter chips
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

  // Clear filter
  document.getElementById('filter-clear-btn')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Open label manager
  document.getElementById('open-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-modal').classList.remove('hidden');
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-modal').classList.add('hidden');
  });

  // Create label form
  document.getElementById('lm-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const err = await apiCreateLabel(name, color);
    if (err) {
      setStatus(`Label error: ${err}`, true);
    } else {
      form.elements.name.value = '';
    }
  });

  // Edit label buttons
  document.querySelectorAll('.lm-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      const editModal = document.getElementById('label-edit-modal');
      const form = document.getElementById('lm-edit-form');
      form.elements.id.value = label.id;
      form.elements.name.value = label.name;
      form.elements.color.value = label.color;
      editModal.classList.remove('hidden');
    });
  });

  // Close edit modal
  document.getElementById('close-label-edit')?.addEventListener('click', () => {
    document.getElementById('label-edit-modal').classList.add('hidden');
  });

  // Edit label form submit
  document.getElementById('lm-edit-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const id = form.elements.id.value;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const err = await apiUpdateLabel(id, name, color);
    if (err) {
      setStatus(`Label error: ${err}`, true);
    } else {
      document.getElementById('label-edit-modal').classList.add('hidden');
    }
  });

  // Delete label buttons
  document.querySelectorAll('.lm-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      const err = await apiDeleteLabel(labelId);
      if (err) setStatus(`Label error: ${err}`, true);
    });
  });

  // Card label assign buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      openCardLabelModal(btn.dataset.cardId);
    });
  });

  // Close card label modal
  document.getElementById('close-card-label')?.addEventListener('click', () => {
    document.getElementById('card-label-modal').classList.add('hidden');
  });

  // Close modals on backdrop click
  document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) backdrop.classList.add('hidden');
    });
  });
}

function openCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const listEl = document.getElementById('card-label-list');
  if (!listEl) return;

  if (allLabels.length === 0) {
    listEl.innerHTML = '<p class="lm-empty">No labels exist yet. Create some in Label Manager.</p>';
  } else {
    listEl.innerHTML = allLabels.map((label) => {
      const checked = assignedIds.has(label.id);
      return `
        <label class="cl-row">
          <input type="checkbox" class="cl-checkbox"
            data-card-id="${escapeHtml(cardId)}"
            data-label-id="${escapeHtml(label.id)}"
            ${checked ? 'checked' : ''}
          />
          <span class="lm-swatch" style="background:${escapeHtml(label.color)}"></span>
          <span>${escapeHtml(label.name)}</span>
        </label>
      `;
    }).join('');

    listEl.querySelectorAll('.cl-checkbox').forEach((checkbox) => {
      checkbox.addEventListener('change', async () => {
        const cId = checkbox.dataset.cardId;
        const lId = checkbox.dataset.labelId;
        if (checkbox.checked) {
          await apiAssignLabel(cId, lId);
        } else {
          await apiUnassignLabel(cId, lId);
        }
      });
    });
  }

  document.getElementById('card-label-modal').classList.remove('hidden');
}

// ── Drag helpers ─────────────────────────────────────────────────────────────

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

// ── API calls ────────────────────────────────────────────────────────────────

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
    await loadBoard();
  }
}

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) return (await response.json()).error || 'Create failed';
    return null;
  } catch (error) {
    return error.message;
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) return (await response.json()).error || 'Update failed';
    return null;
  } catch (error) {
    return error.message;
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) return (await response.json()).error || 'Delete failed';
    return null;
  } catch (error) {
    return error.message;
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) {
      const err = (await response.json()).error || 'Assign failed';
      setStatus(`Assign failed: ${err}`, true);
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = (await response.json()).error || 'Unassign failed';
      setStatus(`Unassign failed: ${err}`, true);
    }
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ── SSE / state application ──────────────────────────────────────────────────

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
  target.cards.push({ ...card, labels: card.labels || [] });
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

function applyLabelMutation(message) {
  // All label mutations carry the full board; just replace state and re-render.
  if (message.board) {
    board = normalizeBoard(message.board);
  }
  if (message.type === 'label-create' && message.label) {
    if (!allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
  } else if (message.type === 'label-update' && message.label) {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    else allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (message.type === 'label-delete') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
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
  allLabels = await response.json();
}

function connectStream() {
  eventSource?.close();
  eventSource = new EventSource(`${API_BASE}/api/stream`);
  eventSource.addEventListener('connected', () => setStatus('Live'));
  eventSource.addEventListener('mutation', (event) => {
    applyMutation(JSON.parse(event.data));
  });
  eventSource.addEventListener('label-mutation', (event) => {
    applyLabelMutation(JSON.parse(event.data));
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
