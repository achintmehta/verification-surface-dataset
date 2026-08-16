import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // [{id, name, color}, …]
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
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return (
    Number(a.position) - Number(b.position) ||
    String(a.created_at).localeCompare(String(b.created_at)) ||
    a.id.localeCompare(b.id)
  );
}

// Returns true if the card passes the current label filter
function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-title">
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button class="btn-labels-manager" id="btn-open-labels">🏷 Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManagerModal()}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar" id="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${allLabels
        .map(
          (label) => `
        <button
          class="filter-chip${activeFilters.has(label.id) ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
        >${escapeHtml(label.name)}</button>
      `
        )
        .join('')}
      ${
        activeFilters.size > 0
          ? `<button class="filter-clear" id="btn-clear-filter">✕ Clear</button>`
          : ''
      }
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  const hiddenCount = column.cards.length - visibleCards.length;
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
        ${hiddenCount > 0 ? `<div class="hidden-cards-notice">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</div>` : ''}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labels = card.labels || [];
  const chipsHtml = labels
    .map(
      (label) => `
      <span
        class="label-chip"
        style="background:${escapeHtml(label.color)}"
        title="${escapeHtml(label.name)}"
      >${escapeHtml(label.name)}</span>
    `
    )
    .join('');

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labels.length > 0 ? `<div class="card-labels">${chipsHtml}</div>` : ''}
      <button class="btn-card-labels" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

// ── Label Manager Modal ───────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay" id="label-manager-overlay" style="display:none">
      <div class="modal" id="label-manager-modal">
        <div class="modal-header">
          <h2>Label Manager</h2>
          <button class="modal-close" id="btn-close-labels">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input
              name="name"
              type="text"
              maxlength="100"
              placeholder="Label name…"
              autocomplete="off"
              required
            />
            <input name="color" type="color" value="#2563eb" title="Label color" />
            <button type="submit">Create</button>
          </form>
          <div id="label-error" class="label-error" style="display:none"></div>
          <ul class="label-list" id="label-list">
            ${renderLabelList()}
          </ul>
        </div>
      </div>
    </div>
  `;
}

function renderLabelList() {
  if (allLabels.length === 0) {
    return '<li class="label-list-empty">No labels yet. Create one above.</li>';
  }
  return allLabels
    .map(
      (label) => `
      <li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
        <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
        <input
          class="label-name-input"
          type="text"
          value="${escapeHtml(label.name)}"
          maxlength="100"
          data-label-id="${escapeHtml(label.id)}"
          data-original-name="${escapeHtml(label.name)}"
        />
        <input
          class="label-color-input"
          type="color"
          value="${escapeHtml(label.color)}"
          data-label-id="${escapeHtml(label.id)}"
          title="Change color"
        />
        <button class="btn-label-save" data-label-id="${escapeHtml(label.id)}">Save</button>
        <button class="btn-label-delete" data-label-id="${escapeHtml(label.id)}">Delete</button>
      </li>
    `
    )
    .join('');
}

// ── Card-label assignment modal ───────────────────────────────────────────────

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal" id="card-label-modal">
        <div class="modal-header">
          <h2>Labels for card</h2>
          <button class="modal-close" id="btn-close-card-labels">✕</button>
        </div>
        <div class="modal-body">
          <p class="card-label-card-text">${escapeHtml(card.text)}</p>
          ${
            allLabels.length === 0
              ? '<p class="label-list-empty">No labels exist yet. Open the Label Manager to create some.</p>'
              : `<ul class="card-label-list">
              ${allLabels
                .map(
                  (label) => `
                <li class="card-label-item">
                  <label>
                    <input
                      type="checkbox"
                      class="card-label-checkbox"
                      data-card-id="${escapeHtml(card.id)}"
                      data-label-id="${escapeHtml(label.id)}"
                      ${cardLabelIds.has(label.id) ? 'checked' : ''}
                    />
                    <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
                    ${escapeHtml(label.name)}
                  </label>
                </li>
              `
                )
                .join('')}
            </ul>`
          }
        </div>
      </div>
    </div>
  `;
}

// ── Event binding ─────────────────────────────────────────────────────────────

function bindEvents() {
  // ── Filter bar ──
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

  const clearFilterBtn = document.getElementById('btn-clear-filter');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // ── Label manager modal ──
  const btnOpenLabels = document.getElementById('btn-open-labels');
  if (btnOpenLabels) {
    btnOpenLabels.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'flex';
    });
  }

  const btnCloseLabels = document.getElementById('btn-close-labels');
  if (btnCloseLabels) {
    btnCloseLabels.addEventListener('click', closeLabelManager);
  }

  const labelOverlay = document.getElementById('label-manager-overlay');
  if (labelOverlay) {
    labelOverlay.addEventListener('click', (e) => {
      if (e.target === labelOverlay) closeLabelManager();
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
      const err = await apiCreateLabel(name, color);
      if (err) {
        showLabelError(err);
      } else {
        createForm.elements.name.value = '';
        hideLabelError();
      }
    });
  }

  // Save / delete label buttons
  document.querySelectorAll('.btn-label-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const li = document.querySelector(`.label-list-item[data-label-id="${labelId}"]`);
      if (!li) return;
      const name = li.querySelector('.label-name-input').value.trim();
      const color = li.querySelector('.label-color-input').value;
      if (!name) {
        showLabelError('Name cannot be empty');
        return;
      }
      const err = await apiUpdateLabel(labelId, name, color);
      if (err) showLabelError(err);
      else hideLabelError();
    });
  });

  document.querySelectorAll('.btn-label-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      await apiDeleteLabel(labelId);
    });
  });

  // Live color swatch preview
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const li = input.closest('.label-list-item');
      if (li) {
        const swatch = li.querySelector('.label-swatch');
        if (swatch) swatch.style.background = input.value;
      }
    });
  });

  // ── Card label buttons ──
  document.querySelectorAll('.btn-card-labels').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const cardId = btn.dataset.cardId;
      openCardLabelModal(cardId);
    });
  });

  // ── Drag and drop ──
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
      event.dataTransfer.dropEffect = 'move';
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', (event) => {
      if (!list.contains(event.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = list.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // ── Add card forms ──
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
}

function closeLabelManager() {
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) overlay.style.display = 'none';
  hideLabelError();
}

function showLabelError(msg) {
  const el = document.getElementById('label-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function hideLabelError() {
  const el = document.getElementById('label-error');
  if (el) el.style.display = 'none';
}

// ── Card-label modal ──────────────────────────────────────────────────────────

function openCardLabelModal(cardId) {
  // Remove any existing card-label modal
  const existing = document.getElementById('card-label-overlay');
  if (existing) existing.remove();

  const found = findCard(cardId);
  if (!found) return;

  const div = document.createElement('div');
  div.innerHTML = renderCardLabelModal(found.card);
  document.body.appendChild(div.firstElementChild);

  const overlay = document.getElementById('card-label-overlay');

  document.getElementById('btn-close-card-labels').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
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

// ── API calls ─────────────────────────────────────────────────────────────────

async function apiCreateLabel(name, color) {
  try {
    const res = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) {
      const body = await res.json();
      return body.error || 'Failed to create label';
    }
    return null;
  } catch {
    return 'Network error';
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const res = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!res.ok) {
      const body = await res.json();
      return body.error || 'Failed to update label';
    }
    return null;
  } catch {
    return 'Network error';
  }
}

async function apiDeleteLabel(id) {
  try {
    await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
  } catch {
    setStatus('Delete failed', true);
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!res.ok) setStatus('Assign failed', true);
  } catch {
    setStatus('Assign failed', true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const res = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!res.ok) setStatus('Unassign failed', true);
  } catch {
    setStatus('Unassign failed', true);
  }
}

// ── Drag helpers ──────────────────────────────────────────────────────────────

function getDropPosition(list, cardId) {
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

// ── Server API calls ──────────────────────────────────────────────────────────

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

// ── SSE / board state ─────────────────────────────────────────────────────────

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

function applyLabelMutation(message) {
  // All label mutations carry the full board; just replace and re-render.
  // Also update allLabels from the board or re-fetch.
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  switch (message.type) {
    case 'label-create': {
      if (!allLabels.find((l) => l.id === message.label.id)) {
        allLabels.push(message.label);
        allLabels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
      const idx = allLabels.findIndex((l) => l.id === message.label.id);
      if (idx !== -1) allLabels[idx] = message.label;
      else allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
      break;
    }
    case 'label-delete': {
      allLabels = allLabels.filter((l) => l.id !== message.labelId);
      // Remove from active filters if it was selected
      activeFilters.delete(message.labelId);
      break;
    }
    case 'card-label-assign':
    case 'card-label-unassign': {
      // board already updated above; card labels come from board
      break;
    }
  }

  render();
  setStatus('Synced');

  // If the label manager modal is open, refresh its list
  const labelList = document.getElementById('label-list');
  if (labelList) {
    labelList.innerHTML = renderLabelList();
    // Re-bind save/delete/color-preview for the refreshed list
    bindLabelListEvents();
  }
}

function bindLabelListEvents() {
  document.querySelectorAll('.btn-label-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const li = document.querySelector(`.label-list-item[data-label-id="${labelId}"]`);
      if (!li) return;
      const name = li.querySelector('.label-name-input').value.trim();
      const color = li.querySelector('.label-color-input').value;
      if (!name) { showLabelError('Name cannot be empty'); return; }
      const err = await apiUpdateLabel(labelId, name, color);
      if (err) showLabelError(err);
      else hideLabelError();
    });
  });

  document.querySelectorAll('.btn-label-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const label = allLabels.find((l) => l.id === labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      await apiDeleteLabel(labelId);
    });
  });

  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const li = input.closest('.label-list-item');
      if (li) {
        const swatch = li.querySelector('.label-swatch');
        if (swatch) swatch.style.background = input.value;
      }
    });
  });
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
    statusTimer = setTimeout(
      () => setStatus(eventSource?.readyState === EventSource.OPEN ? 'Live' : 'Reconnecting…'),
      4000
    );
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
