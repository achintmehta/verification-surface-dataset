import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let allLabels = [];          // full label list from server
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

// ── Rendering ──────────────────────────────────────────────────────────────

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
      title="${active ? 'Remove filter' : 'Filter by'} ${escapeHtml(label.name)}"
    >${escapeHtml(label.name)}</button>`;
  }).join('');

  const clearBtn = activeFilters.size > 0
    ? `<button class="filter-clear" id="clear-filters">Clear filter</button>`
    : '';

  return `
    <div class="label-bar">
      <div class="label-bar-filters">
        <span class="label-bar-title">Filter:</span>
        ${filterChips || '<span class="label-bar-empty">No labels yet</span>'}
        ${clearBtn}
      </div>
      <button class="manage-labels-btn" id="open-label-manager">⚙ Manage Labels</button>
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

// ── Label Manager Modal ────────────────────────────────────────────────────

function renderLabelManagerModal() {
  return `
    <div class="modal-overlay hidden" id="label-manager-overlay">
      <div class="modal" id="label-manager">
        <div class="modal-header">
          <h2>Manage Labels</h2>
          <button class="modal-close" id="close-label-manager">✕</button>
        </div>
        <div class="modal-body">
          <form class="label-create-form" id="label-create-form">
            <input name="name" type="text" maxlength="80" placeholder="Label name…" autocomplete="off" required />
            <input name="color" type="color" value="#3b82f6" title="Pick a color" />
            <button type="submit">Add Label</button>
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
  if (allLabels.length === 0) return '<li class="label-list-empty">No labels yet.</li>';
  return allLabels.map((label) => `
    <li class="label-item" data-label-id="${escapeHtml(label.id)}">
      <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
      <input class="label-name-input" type="text" value="${escapeHtml(label.name)}" maxlength="80"
        data-label-id="${escapeHtml(label.id)}" data-original="${escapeHtml(label.name)}" />
      <input class="label-color-input" type="color" value="${escapeHtml(label.color)}"
        data-label-id="${escapeHtml(label.id)}" data-original-color="${escapeHtml(label.color)}" />
      <button class="label-save-btn" data-label-id="${escapeHtml(label.id)}">Save</button>
      <button class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
    </li>
  `).join('');
}

// ── Card Label Assignment Modal ────────────────────────────────────────────

function renderCardLabelModal(card) {
  const cardLabelIds = new Set((card.labels || []).map((l) => l.id));
  const items = allLabels.map((label) => {
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
      <div class="modal" id="card-label-modal">
        <div class="modal-header">
          <h2>Labels for card</h2>
          <button class="modal-close" id="close-card-label-modal">✕</button>
        </div>
        <div class="modal-body">
          <p class="card-label-card-text">${escapeHtml(card.text)}</p>
          ${allLabels.length === 0
            ? '<p>No labels exist yet. Create some in <b>Manage Labels</b>.</p>'
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
  // Remove any existing card-label overlay
  document.getElementById('card-label-overlay')?.remove();
  const div = document.createElement('div');
  div.innerHTML = renderCardLabelModal(found.card);
  document.body.appendChild(div.firstElementChild);
  bindCardLabelModalEvents();
}

function bindCardLabelModalEvents() {
  document.getElementById('close-card-label-modal')?.addEventListener('click', () => {
    document.getElementById('card-label-overlay')?.remove();
  });
  document.getElementById('card-label-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('card-label-overlay')) {
      document.getElementById('card-label-overlay')?.remove();
    }
  });
  document.querySelectorAll('.card-label-checkbox').forEach((checkbox) => {
    checkbox.addEventListener('change', async (e) => {
      const { cardId, labelId } = e.target.dataset;
      if (e.target.checked) {
        await assignLabel(cardId, labelId);
      } else {
        await unassignLabel(cardId, labelId);
      }
    });
  });
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

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (e) => {
      e.preventDefault();
      list.classList.add('drop-target');
    });
    list.addEventListener('dragleave', (e) => {
      if (!list.contains(e.relatedTarget)) list.classList.remove('drop-target');
    });
    list.addEventListener('drop', async (e) => {
      e.preventDefault();
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

  document.getElementById('clear-filters')?.addEventListener('click', () => {
    activeFilters.clear();
    render();
  });

  // Open label manager
  document.getElementById('open-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay')?.classList.remove('hidden');
  });

  // Close label manager
  document.getElementById('close-label-manager')?.addEventListener('click', () => {
    document.getElementById('label-manager-overlay')?.classList.add('hidden');
  });

  document.getElementById('label-manager-overlay')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('label-manager-overlay')) {
      document.getElementById('label-manager-overlay')?.classList.add('hidden');
    }
  });

  // Create label form
  document.getElementById('label-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = form.elements.name.value.trim();
    const color = form.elements.color.value;
    if (!name) return;
    const err = await createLabel(name, color);
    if (err) {
      showLabelError(err);
    } else {
      form.elements.name.value = '';
      form.elements.color.value = '#3b82f6';
    }
  });

  // Save label buttons
  document.querySelectorAll('.label-save-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      const item = btn.closest('.label-item');
      const nameInput = item.querySelector('.label-name-input');
      const colorInput = item.querySelector('.label-color-input');
      const name = nameInput.value.trim();
      const color = colorInput.value;
      if (!name) return;
      const err = await updateLabel(labelId, name, color);
      if (err) showLabelError(err);
    });
  });

  // Delete label buttons
  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const labelId = btn.dataset.labelId;
      if (!confirm('Delete this label? It will be removed from all cards.')) return;
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

  // Update label swatches live as color inputs change
  document.querySelectorAll('.label-color-input').forEach((input) => {
    input.addEventListener('input', () => {
      const item = input.closest('.label-item');
      const swatch = item?.querySelector('.label-swatch');
      if (swatch) swatch.style.background = input.value;
    });
  });
}

function showLabelError(msg) {
  // Show inline error near the label manager
  let errEl = document.getElementById('label-error');
  if (!errEl) {
    errEl = document.createElement('p');
    errEl.id = 'label-error';
    errEl.className = 'label-error';
    const form = document.getElementById('label-create-form');
    form?.insertAdjacentElement('afterend', errEl);
  }
  errEl.textContent = msg;
  clearTimeout(errEl._timer);
  errEl._timer = setTimeout(() => errEl.remove(), 4000);
}

// ── Drag helpers ───────────────────────────────────────────────────────────

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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) {
      const data = await response.json();
      return data.error || 'Failed to create label';
    }
    // SSE will update allLabels and re-render
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
      return data.error || 'Failed to update label';
    }
    return null;
  } catch (error) {
    return error.message;
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok) {
      const data = await response.json();
      setStatus(`Delete failed: ${data.error}`, true);
    }
    // SSE will update state
  } catch (error) {
    setStatus(`Delete failed: ${error.message}`, true);
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
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

// ── SSE / state application ────────────────────────────────────────────────

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
  const { type } = message;

  if (type === 'label-create') {
    // Add to allLabels if not already present
    if (!allLabels.find((l) => l.id === message.label.id)) {
      allLabels.push(message.label);
      allLabels.sort((a, b) => a.name.localeCompare(b.name));
    }
  } else if (type === 'label-update') {
    const idx = allLabels.findIndex((l) => l.id === message.label.id);
    if (idx !== -1) allLabels[idx] = message.label;
    else allLabels.push(message.label);
    allLabels.sort((a, b) => a.name.localeCompare(b.name));
  } else if (type === 'label-delete') {
    allLabels = allLabels.filter((l) => l.id !== message.labelId);
    // Remove from active filters if it was selected
    activeFilters.delete(message.labelId);
  }

  // For all label mutations that carry a board snapshot, update board state
  if (message.board) {
    board = normalizeBoard(message.board);
  }

  render();
  setStatus('Synced');

  // If the card-label modal is open, refresh it
  const overlay = document.getElementById('card-label-overlay');
  if (overlay) {
    const checkbox = overlay.querySelector('.card-label-checkbox');
    if (checkbox) {
      const cardId = checkbox.dataset.cardId;
      openCardLabelModal(cardId);
    }
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
