import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter bar (client-side view state)
let openMenuCardId = null; // card whose label-assignment menu is open
let labelManagerOpen = false;
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
        .map((card) => ({ ...card, labels: card.labels || [] }))
        .sort(compareCards),
    }))
    .sort((a, b) => Number(a.position) - Number(b.position) || a.id.localeCompare(b.id));
  return { columns };
}

function compareCards(a, b) {
  return Number(a.position) - Number(b.position) || String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id);
}

// A card is visible if no filter is active, or it carries at least one selected label.
function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  return (card.labels || []).some((label) => activeFilter.has(label.id));
}

// Returns a readable text color (black/white) for a given hex background.
function contrastColor(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#172033' : '#ffffff';
}

function render() {
  app.innerHTML = `
    <header class="topbar">
      <div>
        <h1>Collaborative Kanban</h1>
        <p>Drag cards between columns. Updates are broadcast in real time with SSE.</p>
      </div>
      <div class="topbar-actions">
        <button id="manage-labels" type="button" class="ghost-btn">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) {
    return `<div class="filter-bar empty">No labels yet. Use “Manage labels” to create some.</div>`;
  }
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${labels
        .map((label) => {
          const active = activeFilter.has(label.id);
          return `<button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label-id="${escapeHtml(label.id)}"
            style="background:${active ? escapeHtml(label.color) : 'transparent'};border-color:${escapeHtml(label.color)};color:${active ? contrastColor(label.color) : '#172033'}">
            ${escapeHtml(label.name)}
          </button>`;
        })
        .join('')}
      <button type="button" id="clear-filter" class="filter-clear"${activeFilter.size === 0 ? ' disabled' : ''}>Clear</button>
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
      </div>
      ${hiddenCount > 0 ? `<div class="filtered-note">${hiddenCount} card${hiddenCount === 1 ? '' : 's'} hidden by filter</div>` : ''}
    </section>
  `;
}

function renderCard(card) {
  const chips = (card.labels || [])
    .map(
      (label) => `<span class="label-chip" style="background:${escapeHtml(label.color)};color:${contrastColor(label.color)}" title="${escapeHtml(label.name)}">${escapeHtml(label.name)}</span>`
    )
    .join('');
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${chips ? `<div class="card-labels">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="label-toggle" data-card-id="${escapeHtml(card.id)}">＋ Labels</button>
      </div>
      ${openMenuCardId === card.id ? renderLabelMenu(card) : ''}
    </article>
  `;
}

function renderLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((label) => label.id));
  if (labels.length === 0) {
    return `<div class="label-menu" data-card-id="${escapeHtml(card.id)}"><div class="label-menu-empty">No labels yet.</div></div>`;
  }
  return `
    <div class="label-menu" data-card-id="${escapeHtml(card.id)}">
      ${labels
        .map((label) => {
          const on = assigned.has(label.id);
          return `<label class="label-menu-item">
            <input type="checkbox" data-assign-card-id="${escapeHtml(card.id)}" data-assign-label-id="${escapeHtml(label.id)}" ${on ? 'checked' : ''} />
            <span class="label-swatch" style="background:${escapeHtml(label.color)}"></span>
            <span class="label-menu-name">${escapeHtml(label.name)}</span>
          </label>`;
        })
        .join('')}
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-backdrop" id="label-manager-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h3>Manage labels</h3>
          <button type="button" id="close-label-manager" class="icon-btn" aria-label="Close">×</button>
        </div>
        <form id="create-label-form" class="create-label">
          <input name="name" type="text" maxlength="100" placeholder="New label name" autocomplete="off" required />
          <input name="color" type="color" value="#2563eb" />
          <button type="submit">Add</button>
        </form>
        <div id="label-manager-error" class="modal-error"></div>
        <ul class="label-list">
          ${labels
            .map(
              (label) => `<li class="label-list-item" data-label-id="${escapeHtml(label.id)}">
                <input type="color" class="edit-color" data-label-id="${escapeHtml(label.id)}" value="${escapeHtml(label.color)}" />
                <input type="text" class="edit-name" data-label-id="${escapeHtml(label.id)}" maxlength="100" value="${escapeHtml(label.name)}" />
                <button type="button" class="save-label" data-label-id="${escapeHtml(label.id)}">Save</button>
                <button type="button" class="delete-label" data-label-id="${escapeHtml(label.id)}">Delete</button>
              </li>`
            )
            .join('')}
          ${labels.length === 0 ? '<li class="label-list-empty">No labels yet.</li>' : ''}
        </ul>
      </div>
    </div>
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

  // Filter bar
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
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

  // Per-card label assignment menu
  document.querySelectorAll('.label-toggle').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.cardId;
      openMenuCardId = openMenuCardId === id ? null : id;
      render();
    });
  });
  document.querySelectorAll('[data-assign-card-id]').forEach((input) => {
    input.addEventListener('change', async () => {
      const cardId = input.dataset.assignCardId;
      const labelId = input.dataset.assignLabelId;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Label manager
  const manageBtn = document.querySelector('#manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      labelManagerOpen = true;
      render();
    });
  }
  const closeBtn = document.querySelector('#close-label-manager');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      labelManagerOpen = false;
      render();
    });
  }
  const backdrop = document.querySelector('#label-manager-backdrop');
  if (backdrop) {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        labelManagerOpen = false;
        render();
      }
    });
  }
  const createForm = document.querySelector('#create-label-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = createForm.elements.name.value.trim();
      const color = createForm.elements.color.value;
      if (!name) return;
      await createLabel(name, color);
    });
  }
  document.querySelectorAll('.save-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      const name = document.querySelector(`.edit-name[data-label-id="${cssEscape(id)}"]`).value.trim();
      const color = document.querySelector(`.edit-color[data-label-id="${cssEscape(id)}"]`).value;
      await updateLabel(id, name, color);
    });
  });
  document.querySelectorAll('.delete-label').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.labelId);
    });
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function setManagerError(message) {
  const el = document.querySelector('#label-manager-error');
  if (el) el.textContent = message || '';
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

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    setManagerError('');
    const form = document.querySelector('#create-label-form');
    if (form) form.elements.name.value = '';
  } catch (error) {
    setManagerError(error.message);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    setManagerError('');
  } catch (error) {
    setManagerError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
    setManagerError('');
  } catch (error) {
    setManagerError(error.message);
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
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
    await loadBoard();
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(`Unassign failed: ${error.message}`, true);
    await loadBoard();
  }
}

function applyLabelsFromBoard(nextBoard) {
  // Keep the labels list in sync with whatever rides the board payload, if present.
  if (Array.isArray(nextBoard?.labels)) labels = nextBoard.labels;
}

function applyMutation(message) {
  // Label list comes alongside any label mutation.
  if (Array.isArray(message.labels)) {
    labels = message.labels;
    // Drop filter selections for labels that no longer exist.
    for (const id of [...activeFilter]) {
      if (!labels.some((label) => label.id === id)) activeFilter.delete(id);
    }
  }

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

async function loadBoard() {
  const [boardRes, labelsRes] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardRes.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardRes.json());
  if (labelsRes.ok) labels = await labelsRes.json();
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
