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

// Returns true if the card passes the current label filter
function cardMatchesFilter(card) {
  if (activeFilters.size === 0) return true;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  for (const filterId of activeFilters) {
    if (cardLabelIds.has(filterId)) return true;
  }
  return false;
}

// ── Render ─────────────────────────────────────────────────────────────────────

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
    ? `<button class="filter-clear" id="filter-clear">Clear filter</button>`
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

  const labelSection = `<div class="card-labels">${labelChips}</div>`;

  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${labelSection}
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
  `;
}

function renderLabelRow(label) {
  return `
    <li class="label-row" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <span class="label-name">${escapeHtml(label.name)}</span>
      <button class="label-edit-btn" data-label-id="${escapeHtml(label.id)}" title="Edit">✏</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete">🗑</button>
    </li>
  `;
}

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  const rows = labels.map((label) => {
    const assigned = cardLabelIds.has(label.id);
    return `
      <li class="card-label-row">
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
    <div class="modal-overlay" id="card-label-modal-overlay">
      <div class="modal" id="card-label-modal">
        <div class="modal-header">
          <h3>Labels for card</h3>
          <button class="modal-close" id="close-card-label-modal">✕</button>
        </div>
        ${labels.length === 0 ? '<p class="modal-empty">No labels yet. Create some in ⚙ Labels.</p>' : ''}
        <ul class="card-label-list">${rows}</ul>
      </div>
    </div>
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

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('drop-target'));
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = getDropPosition(zone, draggedCardId);
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

  // Clear filter
  const clearBtn = document.getElementById('filter-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      activeFilters.clear();
      render();
    });
  }

  // Open label manager
  const openMgrBtn = document.getElementById('open-label-manager');
  if (openMgrBtn) {
    openMgrBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'flex';
    });
  }

  // Close label manager
  const closeMgrBtn = document.getElementById('close-label-manager');
  if (closeMgrBtn) {
    closeMgrBtn.addEventListener('click', () => {
      document.getElementById('label-manager-overlay').style.display = 'none';
    });
  }

  // Click outside label manager to close
  const overlay = document.getElementById('label-manager-overlay');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.style.display = 'none';
    });
  }

  // Label create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await apiCreateLabel(name, color);
      createForm.elements.name.value = '';
    });
  }

  // Label edit buttons
  document.querySelectorAll('.label-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => openEditLabelModal(btn.dataset.labelId));
  });

  // Label delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const label = labels.find((l) => l.id === btn.dataset.labelId);
      if (!label) return;
      if (!confirm(`Delete label "${label.name}"? It will be removed from all cards.`)) return;
      await apiDeleteLabel(btn.dataset.labelId);
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

// ── Label manager modal helpers ────────────────────────────────────────────────

function openEditLabelModal(labelId) {
  const label = labels.find((l) => l.id === labelId);
  if (!label) return;

  // Remove any existing edit modal
  document.getElementById('edit-label-modal-overlay')?.remove();

  const div = document.createElement('div');
  div.className = 'modal-overlay';
  div.id = 'edit-label-modal-overlay';
  div.innerHTML = `
    <div class="modal" id="edit-label-modal">
      <div class="modal-header">
        <h3>Edit Label</h3>
        <button class="modal-close" id="close-edit-label-modal">✕</button>
      </div>
      <form id="edit-label-form">
        <div class="edit-label-fields">
          <input id="edit-label-name" type="text" maxlength="50" value="${escapeHtml(label.name)}" required />
          <input id="edit-label-color" type="color" value="${escapeHtml(label.color)}" />
          <button type="submit">Save</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(div);

  div.addEventListener('click', (e) => { if (e.target === div) div.remove(); });
  document.getElementById('close-edit-label-modal').addEventListener('click', () => div.remove());
  document.getElementById('edit-label-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('edit-label-name').value.trim();
    const color = document.getElementById('edit-label-color').value;
    if (!name) return;
    await apiUpdateLabel(labelId, name, color);
    div.remove();
  });
}

function openCardLabelModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;

  document.getElementById('card-label-modal-overlay')?.remove();

  const div = document.createElement('div');
  div.innerHTML = renderCardLabelModal(found.card);
  const modalOverlay = div.firstElementChild;
  document.body.appendChild(modalOverlay);

  modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) modalOverlay.remove(); });
  document.getElementById('close-card-label-modal').addEventListener('click', () => modalOverlay.remove());

  modalOverlay.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
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

// ── Drag-and-drop helpers ──────────────────────────────────────────────────────

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
    }
  } catch (error) {
    setStatus(`Label create failed: ${error.message}`, true);
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
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
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
      alert(err.error || 'Failed to assign label');
    }
  } catch (error) {
    setStatus(`Label assign failed: ${error.message}`, true);
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) {
      const err = await response.json();
      alert(err.error || 'Failed to unassign label');
    }
  } catch (error) {
    setStatus(`Label unassign failed: ${error.message}`, true);
  }
}

// ── SSE / mutation handling ────────────────────────────────────────────────────

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

function applyLabelMutation(message) {
  switch (message.type) {
    case 'label-create': {
      if (!labels.find((l) => l.id === message.label.id)) {
        labels.push(message.label);
        labels.sort((a, b) => a.name.localeCompare(b.name));
      }
      break;
    }
    case 'label-update': {
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
      break;
    }
    case 'label-delete': {
      labels = labels.filter((l) => l.id !== message.labelId);
      activeFilters.delete(message.labelId);
      // Remove label from all cards
      for (const column of board.columns) {
        for (const card of column.cards) {
          card.labels = (card.labels || []).filter((l) => l.id !== message.labelId);
        }
      }
      break;
    }
    case 'card-label-assign':
    case 'card-label-unassign': {
      if (message.card) {
        const updatedCard = { ...message.card, labels: message.card.labels || [] };
        removeCardEverywhere(updatedCard.id);
        const target = board.columns.find((col) => col.id === updatedCard.column_id);
        if (target) {
          target.cards.push(updatedCard);
          target.cards.sort(compareCards);
        }
      }
      break;
    }
  }
  render();
  setStatus('Synced');
}

// ── Board loading ──────────────────────────────────────────────────────────────

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (!labelsRes.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardRes.json());
  labels = await labelsRes.json();
  render();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
