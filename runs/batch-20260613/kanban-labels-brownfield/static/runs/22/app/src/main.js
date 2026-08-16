import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];
let activeFilters = new Set(); // label IDs currently filtering
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let labelManagerOpen = false;
let cardLabelMenuCardId = null; // which card's label menu is open

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
      <div class="topbar-actions">
        <button class="btn-manage-labels" id="btn-manage-labels">🏷️ Labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
    ${cardLabelMenuCardId ? renderCardLabelMenu() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (allLabels.length === 0) return '';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter by label:</span>
      ${allLabels.map((label) => `
        <button class="filter-chip ${activeFilters.has(label.id) ? 'active' : ''}"
                data-label-id="${escapeHtml(label.id)}"
                style="--chip-color: ${escapeHtml(label.color)}">
          ${escapeHtml(label.name)}
        </button>
      `).join('')}
      ${activeFilters.size > 0 ? '<button class="filter-clear" id="filter-clear">Clear</button>' : ''}
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
  const labelsHtml = (card.labels || []).map((label) => `
    <span class="card-label-chip" style="background: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>
  `).join('');

  return `
    <article class="card ${visible ? '' : 'card-hidden'}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-labels">${labelsHtml}</div>
      <div class="card-text">${escapeHtml(card.text)}</div>
      <button class="card-label-btn" data-card-id="${escapeHtml(card.id)}" title="Manage labels">🏷️</button>
    </article>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal label-manager">
        <div class="modal-header">
          <h3>Manage Labels</h3>
          <button class="modal-close" id="label-manager-close">&times;</button>
        </div>
        <form class="label-create-form" id="label-create-form">
          <input name="name" type="text" placeholder="Label name…" autocomplete="off" maxlength="50" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Create</button>
        </form>
        <ul class="label-list">
          ${allLabels.map((label) => `
            <li class="label-item" data-label-id="${escapeHtml(label.id)}">
              <span class="label-swatch" style="background: ${escapeHtml(label.color)}"></span>
              <input class="label-name-input" type="text" value="${escapeHtml(label.name)}" data-label-id="${escapeHtml(label.id)}" data-original="${escapeHtml(label.name)}" maxlength="50" />
              <input class="label-color-input" type="color" value="${escapeHtml(label.color)}" data-label-id="${escapeHtml(label.id)}" data-original="${escapeHtml(label.color)}" />
              <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}" title="Delete label">&times;</button>
            </li>
          `).join('')}
          ${allLabels.length === 0 ? '<li class="label-empty">No labels yet.</li>' : ''}
        </ul>
      </div>
    </div>
  `;
}

function renderCardLabelMenu() {
  const result = findCard(cardLabelMenuCardId);
  if (!result) return '';
  const card = result.card;
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));

  return `
    <div class="modal-overlay" id="card-label-overlay">
      <div class="modal card-label-modal">
        <div class="modal-header">
          <h3>Labels for card</h3>
          <button class="modal-close" id="card-label-close">&times;</button>
        </div>
        <div class="card-label-list">
          ${allLabels.map((label) => `
            <label class="card-label-option">
              <input type="checkbox" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}"
                     ${cardLabelIds.has(label.id) ? 'checked' : ''} />
              <span class="card-label-chip-lg" style="background: ${escapeHtml(label.color)}">${escapeHtml(label.name)}</span>
            </label>
          `).join('')}
          ${allLabels.length === 0 ? '<p class="label-empty">No labels. Create labels first.</p>' : ''}
        </div>
      </div>
    </div>
  `;
}

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

  // Drag and drop
  document.querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (event) => {
      draggedCardId = el.dataset.cardId;
      el.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((zone) => zone.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((zone) => {
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      zone.classList.add('drop-target');
      const dragged = document.querySelector('.card.dragging');
      if (!dragged) return;
      const closest = closestCard(zone, event.clientY);
      if (closest) {
        zone.insertBefore(dragged, closest);
      } else {
        zone.appendChild(dragged);
      }
    });
    zone.addEventListener('dragleave', (event) => {
      if (!zone.contains(event.relatedTarget)) zone.classList.remove('drop-target');
    });
    zone.addEventListener('drop', async (event) => {
      event.preventDefault();
      zone.classList.remove('drop-target');
      if (!draggedCardId) return;
      const columnId = zone.dataset.columnId;
      const { afterId, beforeId } = neighborIds(zone, draggedCardId);
      optimisticMove(draggedCardId, columnId, beforeId, afterId);
      render();
      await moveCard(draggedCardId, columnId, beforeId, afterId);
    });
  });

  // Card label buttons
  document.querySelectorAll('.card-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      cardLabelMenuCardId = btn.dataset.cardId;
      render();
    });
  });

  // Label manager button
  const manageBtn = document.getElementById('btn-manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }

  // Label manager modal
  const managerClose = document.getElementById('label-manager-close');
  if (managerClose) {
    managerClose.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }
  const managerOverlay = document.getElementById('label-manager-overlay');
  if (managerOverlay) {
    managerOverlay.addEventListener('click', (event) => {
      if (event.target === managerOverlay) {
        labelManagerOpen = false;
        render();
      }
    });
  }

  // Label create form
  const createForm = document.getElementById('label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await createLabel(name, color);
      createForm.elements.name.value = '';
    });
  }

  // Label name/color inline edit (blur = save)
  document.querySelectorAll('.label-name-input').forEach((input) => {
    input.addEventListener('blur', async () => {
      const labelId = input.dataset.labelId;
      const newName = input.value.trim();
      const original = input.dataset.original;
      const colorInput = document.querySelector(`.label-color-input[data-label-id="${labelId}"]`);
      const color = colorInput ? colorInput.value : '#000000';
      if (newName && (newName !== original || color !== colorInput?.dataset.original)) {
        await updateLabel(labelId, newName, color);
      }
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    });
  });

  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('change', async () => {
      const labelId = input.dataset.labelId;
      const newColor = input.value;
      const nameInput = document.querySelector(`.label-name-input[data-label-id="${labelId}"]`);
      const name = nameInput ? nameInput.value.trim() : '';
      if (name) {
        await updateLabel(labelId, name, newColor);
      }
    });
  });

  // Label delete buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Card label overlay
  const cardLabelClose = document.getElementById('card-label-close');
  if (cardLabelClose) {
    cardLabelClose.addEventListener('click', () => {
      cardLabelMenuCardId = null;
      render();
    });
  }
  const cardLabelOverlay = document.getElementById('card-label-overlay');
  if (cardLabelOverlay) {
    cardLabelOverlay.addEventListener('click', (event) => {
      if (event.target === cardLabelOverlay) {
        cardLabelMenuCardId = null;
        render();
      }
    });
  }

  // Card label checkboxes
  document.querySelectorAll('.card-label-option input[type="checkbox"]').forEach((cb) => {
    cb.addEventListener('change', async () => {
      const cardId = cb.dataset.cardId;
      const labelId = cb.dataset.labelId;
      if (cb.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });

  // Filter chips
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const labelId = chip.dataset.labelId;
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
}

function closestCard(zone, y) {
  const cards = [...zone.querySelectorAll('.card:not(.dragging)')];
  let closest = null;
  let closestOffset = Number.NEGATIVE_INFINITY;
  for (const card of cards) {
    const box = card.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closestOffset) {
      closestOffset = offset;
      closest = card;
    }
  }
  return closest;
}

function neighborIds(list, cardId) {
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

// ─── API calls ────────────────────────────────────────────────

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
    board = normalizeBoard(board);
    render();
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
      throw new Error(err.error || 'Create label failed');
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
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
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      const err = await response.json();
      throw new Error(err.error || 'Delete label failed');
    }
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
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
    setStatus(`Label error: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Label error: ${error.message}`, true);
  }
}

// ─── SSE & state ──────────────────────────────────────────────

function applyMutation(message) {
  // Handle label mutations
  if (message.type === 'label-created') {
    if (!allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-updated') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-deleted') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    activeFilters.delete(message.labelId);
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  if (message.type === 'label-assigned' || message.type === 'label-unassigned') {
    if (message.board) {
      board = normalizeBoard(message.board);
    }
    render();
    setStatus('Synced');
    return;
  }

  // Existing card mutations
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
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  if (!labelsRes.ok) throw new Error('Could not load labels');
  board = normalizeBoard(await boardRes.json());
  allLabels = await labelsRes.json();
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
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
