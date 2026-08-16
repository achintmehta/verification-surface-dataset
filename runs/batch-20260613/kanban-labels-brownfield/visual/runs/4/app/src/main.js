import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all known labels
let activeFilters = new Set(); // label ids currently selected for filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

// ── Utilities ──────────────────────────────────────────────────────────────

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

// ── Render ─────────────────────────────────────────────────────────────────

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
  return `
    <div class="filter-bar">
      <span class="filter-label-text">Filter:</span>
      ${labels.map((l) => `
        <button
          class="filter-chip${activeFilters.has(l.id) ? ' active' : ''}"
          data-filter-label-id="${escapeHtml(l.id)}"
          style="--chip-color:${escapeHtml(l.color)}"
        >${escapeHtml(l.name)}</button>
      `).join('')}
      ${activeFilters.size > 0 ? `<button class="filter-clear" id="clear-filters">Clear</button>` : ''}
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = activeFilters.size === 0
    ? column.cards
    : column.cards.filter((card) => (card.labels || []).some((l) => activeFilters.has(l.id)));

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
  const chipsHtml = cardLabels.length > 0
    ? `<div class="card-chips">${cardLabels.map((l) => `
        <span class="label-chip" style="background:${escapeHtml(l.color)}" title="${escapeHtml(l.name)}">${escapeHtml(l.name)}</span>
      `).join('')}</div>`
    : '';

  const assignedIds = new Set(cardLabels.map((l) => l.id));
  const labelMenuItems = labels.map((l) => {
    const assigned = assignedIds.has(l.id);
    return `
      <button
        class="label-menu-item${assigned ? ' assigned' : ''}"
        data-card-id="${escapeHtml(card.id)}"
        data-label-id="${escapeHtml(l.id)}"
        data-assigned="${assigned}"
        style="--chip-color:${escapeHtml(l.color)}"
      >
        <span class="label-menu-dot" style="background:${escapeHtml(l.color)}"></span>
        ${escapeHtml(l.name)}
        ${assigned ? '<span class="label-menu-check">✓</span>' : ''}
      </button>
    `;
  }).join('');

  const labelBtnHtml = `
    <div class="card-label-menu-wrap">
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">Labels</button>
      <div class="card-label-menu" id="label-menu-${escapeHtml(card.id)}" hidden>
        ${labels.length === 0 ? '<span class="label-menu-empty">No labels yet</span>' : labelMenuItems}
      </div>
    </div>
  `;

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-body">${escapeHtml(card.text)}</div>
      ${chipsHtml}
      ${labelBtnHtml}
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-wrap">
      <details class="label-manager" id="label-manager">
        <summary class="label-manager-toggle">▸ Manage Labels</summary>
        <div class="label-manager-body">
          <form class="label-create-form" id="label-create-form">
            <input
              name="name"
              type="text"
              maxlength="50"
              placeholder="Label name…"
              autocomplete="off"
              class="label-name-input"
            />
            <input name="color" type="color" value="#3b82f6" class="label-color-input" title="Pick a color" />
            <button type="submit" class="label-create-btn">Add Label</button>
          </form>
          <div class="label-list" id="label-list">
            ${labels.length === 0
              ? '<p class="label-list-empty">No labels yet.</p>'
              : labels.map(renderLabelRow).join('')}
          </div>
        </div>
      </details>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <div class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-row-name" data-label-id="${escapeHtml(label.id)}">${escapeHtml(label.name)}</span>
      <div class="label-row-actions">
        <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏️</button>
        <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
      </div>
    </div>
  `;
}

// ── Event binding ──────────────────────────────────────────────────────────

function bindEvents() {
  // Add-card forms
  document.querySelectorAll('.add-card').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = form.elements.text;
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      const columnId = form.dataset.columnId;
      await createCard(columnId, text);
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
      const { afterId, beforeId } = getDropNeighbours(list, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((btn) => {
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

  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Label manager: create
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      const err = await apiCreateLabel(name, color);
      if (err) {
        showLabelError(err);
      } else {
        createForm.elements.name.value = '';
      }
    });
  }

  // Label manager: edit / delete
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditLabel(btn.dataset.labelId));
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const label = labels.find((l) => l.id === id);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? This will remove it from all cards.`)) return;
      await apiDeleteLabel(id);
    });
  });

  // Card label buttons — toggle menu
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      const menu = document.getElementById(`label-menu-${cardId}`);
      if (!menu) return;
      // Close all other menus
      document.querySelectorAll('.card-label-menu').forEach((m) => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });
  });

  // Card label menu items — assign/unassign
  document.querySelectorAll('.label-menu-item').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const { cardId, labelId, assigned } = btn.dataset;
      if (assigned === 'true') {
        await apiUnassignLabel(cardId, labelId);
      } else {
        await apiAssignLabel(cardId, labelId);
      }
    });
  });

  // Close label menus when clicking outside
  document.addEventListener('click', () => {
    document.querySelectorAll('.card-label-menu').forEach((m) => (m.hidden = true));
  });
}

function openEditLabel(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;

  const row = document.querySelector(`.label-row[data-label-id="${labelId}"]`);
  if (!row) return;

  row.innerHTML = `
    <form class="label-edit-form" data-label-id="${escapeHtml(labelId)}">
      <input name="name" type="text" maxlength="50" value="${escapeHtml(label.name)}" class="label-name-input" autocomplete="off" />
      <input name="color" type="color" value="${escapeHtml(label.color)}" class="label-color-input" />
      <button type="submit" class="label-create-btn">Save</button>
      <button type="button" class="label-cancel-btn" data-label-id="${escapeHtml(labelId)}">Cancel</button>
    </form>
  `;

  const form = row.querySelector('.label-edit-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const err = await apiUpdateLabel(labelId, name, color);
    if (err) {
      showLabelError(err);
    }
    // render() will be called by the SSE event or we re-render on success
  });

  row.querySelector('.label-cancel-btn').addEventListener('click', () => render());
}

function showLabelError(message) {
  let errEl = document.getElementById('label-error');
  if (!errEl) {
    errEl = document.createElement('div');
    errEl.id = 'label-error';
    errEl.className = 'label-error';
    const body = document.querySelector('.label-manager-body');
    if (body) body.prepend(errEl);
  }
  errEl.textContent = message;
  clearTimeout(errEl._timer);
  errEl._timer = setTimeout(() => errEl.remove(), 4000);
}

// ── Drag helpers ───────────────────────────────────────────────────────────

function getDropNeighbours(list, cardId) {
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

// ── API calls ──────────────────────────────────────────────────────────────

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

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) return (await response.json()).error || 'Failed to create label';
    return null;
  } catch {
    return 'Network error';
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) return (await response.json()).error || 'Failed to update label';
    return null;
  } catch {
    return 'Network error';
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      setStatus('Delete label failed', true);
    }
  } catch {
    setStatus('Delete label failed', true);
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) setStatus('Assign label failed', true);
  } catch {
    setStatus('Assign label failed', true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) setStatus('Unassign label failed', true);
  } catch {
    setStatus('Unassign label failed', true);
  }
}

// ── SSE / mutation handling ────────────────────────────────────────────────

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

function applyLabelEvent(message) {
  const { type } = message;

  if (type === 'label-created') {
    if (!labels.find((l) => l.id === message.label.id)) {
      labels.push(message.label);
      labels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-updated') {
    const idx = labels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) labels[idx] = message.label;
    else labels.push(message.label);
    labels.sort((a, b) => a.name.localeCompare(b.name));
    // Update label data on all cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        card.labels = (card.labels || []).map((l) =>
          l.id === message.label.id ? message.label : l
        );
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-deleted') {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    // Remove from all cards
    for (const column of board.columns) {
      for (const card of column.cards) {
        card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
      }
    }
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-assigned' || type === 'label-unassigned') {
    if (message.card) {
      // Update the card in our local board state
      const found = findCard(message.card.id);
      if (found) {
        found.card.labels = message.card.labels || [];
      } else {
        // Card might not be in our board yet; add it
        const target = board.columns.find((c) => c.id === message.card.column_id);
        if (target) {
          target.cards.push({ ...message.card, labels: message.card.labels || [] });
          target.cards.sort(compareCards);
        }
      }
    }
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
