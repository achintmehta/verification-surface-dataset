import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = []; // all labels from server
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

// ── Filtering ────────────────────────────────────────────────────────────────

function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Rendering ────────────────────────────────────────────────────────────────

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
      title="${active ? 'Remove filter' : 'Filter by'} ${escapeHtml(label.name)}"
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
      <button class="manage-labels-btn" id="open-label-manager">⚙ Labels</button>
    </div>
  `;
}

function renderColumn(column) {
  const visibleCards = column.cards.filter(cardMatchesFilter);
  const hiddenCount = column.cards.length - visibleCards.length;
  const hiddenNote = hiddenCount > 0
    ? `<p class="hidden-note">${hiddenCount} card${hiddenCount > 1 ? 's' : ''} hidden by filter</p>`
    : '';
  return `
    <section class="column" data-column-id="${escapeHtml(column.id)}">
      <h2>${escapeHtml(column.title)}</h2>
      <form class="add-card" data-column-id="${escapeHtml(column.id)}">
        <input name="text" type="text" maxlength="500" placeholder="Add a card…" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      ${hiddenNote}
      <div class="cards" data-column-id="${escapeHtml(column.id)}">
        ${visibleCards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const labelChips = (card.labels || []).map((label) =>
    `<span class="label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
  ).join('');
  const labelsHtml = labelChips
    ? `<div class="card-labels">${labelChips}</div>`
    : '';
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelsHtml}
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="label-manager-overlay" id="label-manager-overlay" style="display:none">
      <div class="label-manager" id="label-manager">
        <div class="label-manager-header">
          <h2>Labels</h2>
          <button class="label-manager-close" id="close-label-manager">✕</button>
        </div>
        <ul class="label-list" id="label-list">
          ${labels.map(renderLabelRow).join('')}
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" maxlength="50" placeholder="Label name…" autocomplete="off" required />
          <input name="color" type="color" value="#3b82f6" title="Pick a color" />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
    <div class="card-label-overlay" id="card-label-overlay" style="display:none">
      <div class="card-label-panel" id="card-label-panel">
        <div class="label-manager-header">
          <h2>Card Labels</h2>
          <button class="label-manager-close" id="close-card-label-panel">✕</button>
        </div>
        <ul class="card-label-list" id="card-label-list"></ul>
      </div>
    </div>
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-row-name">${escapeHtml(label.name)}</span>
      <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
    </li>
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
      const cardId = draggedCardId;
      optimisticMove(cardId, columnId, beforeId, afterId);
      render();
      await moveCard(cardId, columnId, beforeId, afterId);
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

  // Clear filter
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Open label manager
  const openLabelManager = document.getElementById('open-label-manager');
  if (openLabelManager) {
    openLabelManager.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'flex';
    });
  }

  // Close label manager
  const closeLabelManager = document.getElementById('close-label-manager');
  if (closeLabelManager) {
    closeLabelManager.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'none';
    });
  }

  // Click outside label manager overlay
  const labelManagerOverlay = document.getElementById('label-manager-overlay');
  if (labelManagerOverlay) {
    labelManagerOverlay.addEventListener('click', (e) => {
      if (e.target === labelManagerOverlay) {
        labelManagerOverlay.style.display = 'none';
      }
    });
  }

  // Label create form
  const labelCreateForm = document.getElementById('label-create-form');
  if (labelCreateForm) {
    labelCreateForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = labelCreateForm.elements.name.value.trim();
      const color = labelCreateForm.elements.color.value;
      if (!name) return;
      const ok = await apiCreateLabel(name, color);
      if (ok) {
        labelCreateForm.elements.name.value = '';
      }
    });
  }

  // Label edit / delete buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditLabel(btn.dataset.labelId));
  });
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', () => apiDeleteLabel(btn.dataset.labelId));
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openCardLabelPanel(btn.dataset.cardId);
    });
  });

  // Close card label panel
  const closeCardLabelPanel = document.getElementById('close-card-label-panel');
  if (closeCardLabelPanel) {
    closeCardLabelPanel.addEventListener('click', () => {
      document.getElementById('card-label-overlay').style.display = 'none';
    });
  }

  const cardLabelOverlay = document.getElementById('card-label-overlay');
  if (cardLabelOverlay) {
    cardLabelOverlay.addEventListener('click', (e) => {
      if (e.target === cardLabelOverlay) {
        cardLabelOverlay.style.display = 'none';
      }
    });
  }
}

// ── Label manager helpers ────────────────────────────────────────────────────

function openEditLabel(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;

  const name = prompt('Rename label:', label.name);
  if (name === null) return; // cancelled
  const trimmed = name.trim();
  if (!trimmed) {
    alert('Label name cannot be empty.');
    return;
  }

  // Use a color input via a temporary element
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = label.color;
  colorInput.style.position = 'fixed';
  colorInput.style.opacity = '0';
  colorInput.style.pointerEvents = 'none';
  document.body.appendChild(colorInput);

  // Show a simple confirm dialog with current color
  const newColor = prompt('Color (hex, e.g. #3b82f6):', label.color);
  document.body.removeChild(colorInput);
  if (newColor === null) return;
  const trimmedColor = newColor.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(trimmedColor)) {
    alert('Invalid hex color. Use format #rrggbb.');
    return;
  }
  apiUpdateLabel(labelId, trimmed, trimmedColor);
}

function openCardLabelPanel(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  const card = found.card;
  const assignedIds = new Set((card.labels || []).map((l) => l.id));

  const list = document.getElementById('card-label-list');
  list.innerHTML = labels.length === 0
    ? '<li class="no-labels-note">No labels yet. Create some in ⚙ Labels.</li>'
    : labels.map((label) => {
        const assigned = assignedIds.has(label.id);
        return `<li class="card-label-item">
          <label>
            <input type="checkbox" class="card-label-checkbox"
              data-card-id="${escapeHtml(cardId)}"
              data-label-id="${escapeHtml(label.id)}"
              ${assigned ? 'checked' : ''} />
            <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
            ${escapeHtml(label.name)}
          </label>
        </li>`;
      }).join('');

  // Bind checkbox events
  list.querySelectorAll('.card-label-checkbox').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cId = cb.dataset.cardId;
      const lId = cb.dataset.labelId;
      if (cb.checked) {
        await apiAssignLabel(cId, lId);
      } else {
        await apiUnassignLabel(cId, lId);
      }
    });
  });

  document.getElementById('card-label-overlay').style.display = 'flex';
}

// ── Drag-and-drop helpers ────────────────────────────────────────────────────

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
  }
}

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      alert(err.error || 'Failed to create label');
      return false;
    }
    return true;
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
    return false;
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const err = await response.json();
      alert(err.error || 'Failed to update label');
    }
  } catch (error) {
    setStatus(`Label update failed: ${error.message}`, true);
  }
}

async function apiDeleteLabel(id) {
  if (!confirm('Delete this label? It will be removed from all cards.')) return;
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) {
      const err = await response.json();
      alert(err.error || 'Failed to delete label');
    }
  } catch (error) {
    setStatus(`Label delete failed: ${error.message}`, true);
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
      const err = await response.json();
      setStatus(`Assign failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const err = await response.json();
      setStatus(`Unassign failed: ${err.error}`, true);
    }
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ── SSE / mutation handling ──────────────────────────────────────────────────

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
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'label-deleted') {
    labels = labels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    if (message.board) board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (type === 'card-label-assigned' || type === 'card-label-unassigned') {
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
