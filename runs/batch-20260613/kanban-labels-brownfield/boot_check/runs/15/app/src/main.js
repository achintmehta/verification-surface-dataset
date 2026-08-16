import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
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

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button type="button" id="manage-labels" class="ghost-btn">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${renderLabelManager()}
  `;
  bindEvents();
  bindLabelEvents();
}

function bindLabelEvents() {
  // Filter bar
  document.querySelectorAll('[data-filter-label]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabel;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  const clearFilter = document.querySelector('#clear-filter');
  if (clearFilter) {
    clearFilter.addEventListener('click', () => {
      activeFilter.clear();
      render();
    });
  }

  // Label manager open/close
  const manageBtn = document.querySelector('#manage-labels');
  const overlay = document.querySelector('#label-manager-overlay');
  if (manageBtn && overlay) {
    manageBtn.addEventListener('click', () => overlay.classList.remove('hidden'));
  }
  const closeBtn = document.querySelector('#close-label-manager');
  if (closeBtn && overlay) {
    closeBtn.addEventListener('click', () => overlay.classList.add('hidden'));
  }
  if (overlay) {
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.classList.add('hidden');
    });
  }

  // Create label
  const createForm = document.querySelector('#label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = document.querySelector('#new-label-name').value.trim();
      const color = document.querySelector('#new-label-color').value;
      await createLabel(name, color);
    });
  }

  // Save (rename/recolor) and delete existing labels
  document.querySelectorAll('.label-save').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const row = document.querySelector(`.label-row[data-label-id="${cssEscape(id)}"]`);
      if (!row) return;
      const name = row.querySelector('.label-name-input').value.trim();
      const color = row.querySelector('.label-color-input').value;
      await updateLabel(id, name, color);
    });
  });
  document.querySelectorAll('.label-delete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });

  // Per-card label picker toggle
  document.querySelectorAll('.card-add-label').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      const picker = document.querySelector(`.label-picker[data-card-id="${cssEscape(cardId)}"]`);
      if (picker) picker.classList.toggle('hidden');
    });
  });
  document.querySelectorAll('.label-picker-item').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      if (btn.classList.contains('assigned')) await unassignLabel(cardId, labelId);
      else await assignLabel(cardId, labelId);
    });
  });
  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.labelId);
    });
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\\]]/g, '\\$&');
}

function setLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
}

async function createLabel(name, color) {
  if (!name) {
    setLabelError('Name is required.');
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    setLabelError('');
    const created = await response.json();
    upsertLabel(created);
    render();
    keepLabelManagerOpen();
  } catch (error) {
    setLabelError(error.message);
  }
}

async function updateLabel(id, name, color) {
  if (!name) {
    setLabelError('Name is required.');
    return;
  }
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    setLabelError('');
    const updated = await response.json();
    upsertLabel(updated);
    applyLabelToBoard(updated);
    render();
    keepLabelManagerOpen();
  } catch (error) {
    setLabelError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) throw new Error((await response.json()).error || 'Delete failed');
    setLabelError('');
    removeLabelLocally(id);
    render();
    keepLabelManagerOpen();
  } catch (error) {
    setLabelError(error.message);
  }
}

async function assignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
    const card = await response.json();
    updateCardLocally(card);
    render();
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
    const card = await response.json();
    updateCardLocally(card);
    render();
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
  }
}

function keepLabelManagerOpen() {
  const overlay = document.querySelector('#label-manager-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function upsertLabel(label) {
  const index = labels.findIndex((l) => l.id === label.id);
  if (index === -1) labels.push(label);
  else labels[index] = label;
  labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function removeLabelLocally(id) {
  labels = labels.filter((l) => l.id !== id);
  activeFilter.delete(id);
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.labels) card.labels = card.labels.filter((l) => l.id !== id);
    }
  }
}

function applyLabelToBoard(label) {
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (!card.labels) continue;
      const idx = card.labels.findIndex((l) => l.id === label.id);
      if (idx !== -1) card.labels[idx] = { ...label };
    }
  }
}

function updateCardLocally(card) {
  for (const column of board.columns) {
    const existing = column.cards.find((c) => c.id === card.id);
    if (existing) existing.labels = card.labels || [];
  }
}

function renderFilterBar() {
  if (labels.length === 0) return '<div class="filter-bar empty">No labels yet — create some with “Manage labels”.</div>';
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${labels
        .map((label) => {
          const active = activeFilter.has(label.id);
          return `<button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label="${escapeHtml(label.id)}" style="--chip-color:${escapeHtml(label.color)}">
            <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>${escapeHtml(label.name)}
          </button>`;
        })
        .join('')}
      ${activeFilter.size > 0 ? '<button type="button" class="filter-clear" id="clear-filter">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay hidden" id="label-manager-overlay">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Manage labels</h2>
          <button type="button" class="modal-close" id="close-label-manager" aria-label="Close">×</button>
        </div>
        <ul class="label-list">
          ${labels
            .map(
              (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color-input" value="${escapeHtml(toColorInputValue(label.color))}" data-label-id="${escapeHtml(label.id)}" />
              <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" maxlength="100" data-label-id="${escapeHtml(label.id)}" />
              <button type="button" class="label-save" data-label-id="${escapeHtml(label.id)}">Save</button>
              <button type="button" class="label-delete" data-label-id="${escapeHtml(label.id)}">Delete</button>
            </li>`
            )
            .join('')}
          ${labels.length === 0 ? '<li class="label-empty">No labels yet.</li>' : ''}
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input type="color" id="new-label-color" value="#2563eb" />
          <input type="text" id="new-label-name" placeholder="New label name" maxlength="100" autocomplete="off" />
          <button type="submit">Create</button>
        </form>
        <p class="label-error" id="label-error"></p>
      </div>
    </div>
  `;
}

function toColorInputValue(color) {
  if (typeof color !== 'string') return '#000000';
  const c = color.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) {
    return '#' + c.slice(1).split('').map((ch) => ch + ch).join('');
  }
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return '#000000';
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
}

function renderCard(card) {
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map(
      (label) => `
      <span class="card-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
        <span class="card-chip-text">${escapeHtml(label.name)}</span>
        <button type="button" class="chip-remove" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" aria-label="Remove label">×</button>
      </span>`
    )
    .join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length > 0 ? `<div class="card-chips">${chips}</div>` : ''}
      <div class="card-actions">
        <button type="button" class="card-add-label" data-card-id="${escapeHtml(card.id)}">+ Label</button>
        <div class="label-picker hidden" data-card-id="${escapeHtml(card.id)}">
          ${
            labels.length === 0
              ? '<div class="label-picker-empty">No labels yet</div>'
              : labels
                  .map((label) => {
                    const assigned = cardLabels.some((l) => l.id === label.id);
                    return `<button type="button" class="label-picker-item${assigned ? ' assigned' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
                      <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>${escapeHtml(label.name)}${assigned ? ' ✓' : ''}
                    </button>`;
                  })
                  .join('')
          }
        </div>
      </div>
    </article>
  `;
}

function bindEvents() {
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

  document.querySelectorAll('.card').forEach((cardEl) => {
    cardEl.addEventListener('dragstart', (event) => {
      draggedCardId = cardEl.dataset.cardId;
      cardEl.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', draggedCardId);
    });
    cardEl.addEventListener('dragend', () => {
      cardEl.classList.remove('dragging');
      draggedCardId = null;
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  });

  document.querySelectorAll('.cards').forEach((list) => {
    list.addEventListener('dragover', (event) => {
      event.preventDefault();
      list.classList.add('drop-target');
      const afterElement = getDragAfterElement(list, event.clientY);
      const dragging = document.querySelector('.dragging');
      if (!dragging) return;
      if (afterElement == null) list.appendChild(dragging);
      else list.insertBefore(dragging, afterElement);
    });
    list.addEventListener('dragleave', () => list.classList.remove('drop-target'));
    list.addEventListener('drop', async (event) => {
      event.preventDefault();
      list.classList.remove('drop-target');
      const cardId = draggedCardId || event.dataTransfer.getData('text/plain');
      if (!cardId) return;
      const columnId = list.dataset.columnId;
      const { beforeId, afterId } = getNeighborsFromDom(list, cardId);
      optimisticMove(cardId, columnId, beforeId, afterId);
      try {
        const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/move`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ columnId, beforeId, afterId }),
        });
        if (!response.ok) throw new Error((await response.json()).error || 'Move failed');
      } catch (error) {
        setStatus(`Move rejected: ${error.message}`, true);
        await loadBoard();
      }
    });
  });
}

function getDragAfterElement(container, y) {
  const draggableElements = [...container.querySelectorAll('.card:not(.dragging)')];
  return draggableElements.reduce(
    (closest, child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: child };
      return closest;
    },
    { offset: Number.NEGATIVE_INFINITY, element: null }
  ).element;
}

function getNeighborsFromDom(list, cardId) {
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

function applyMutation(message) {
  // Label-only mutations (no card/board payload).
  if (message.type === 'label-create' || message.type === 'label-update') {
    upsertLabel(message.label);
    if (message.type === 'label-update') applyLabelToBoard(message.label);
    render();
    setStatus('Synced');
    return;
  }
  if (message.type === 'label-delete') {
    removeLabelLocally(message.labelId);
    render();
    setStatus('Synced');
    return;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) return;
  const card = message.card;
  // Label assign/unassign keep the card in place; just update its labels.
  if (message.type === 'label-assign' || message.type === 'label-unassign') {
    updateCardLocally(card);
    render();
    setStatus('Synced');
    return;
  }
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

async function loadBoard() {
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
  render();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
