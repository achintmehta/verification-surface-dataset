import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let showLabelManager = false;
let openCardMenuId = null;

const DEFAULT_COLOR = '#2563eb';

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

function labelById(id) {
  return labels.find((label) => label.id === id) || null;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((label) => label.id);
  for (const id of activeFilter) {
    if (cardLabelIds.includes(id)) return true;
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
        <button type="button" id="manage-labels" class="ghost-btn">Manage labels</button>
        <div id="status" class="status">Connecting…</div>
      </div>
    </header>
    ${renderFilterBar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${showLabelManager ? renderLabelManager() : ''}
  `;
  bindEvents();
}

function renderFilterBar() {
  if (labels.length === 0) return '';
  const chips = labels
    .map((label) => {
      const active = activeFilter.has(label.id);
      return `
        <button type="button" class="filter-chip${active ? ' active' : ''}" data-filter-label="${escapeHtml(label.id)}" style="--chip-color: ${escapeHtml(label.color)}">
          <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </button>
      `;
    })
    .join('');
  return `
    <div class="filter-bar">
      <span class="filter-label">Filter:</span>
      ${chips}
      ${activeFilter.size > 0 ? '<button type="button" id="clear-filter" class="ghost-btn small">Clear</button>' : ''}
    </div>
  `;
}

function renderLabelManager() {
  const rows = labels
    .map(
      (label) => `
      <li class="label-row" data-label-id="${escapeHtml(label.id)}">
        <input type="color" class="label-color-input" value="${escapeHtml(label.color)}" data-action="recolor" />
        <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" maxlength="60" data-action="rename" />
        <button type="button" class="ghost-btn small danger" data-action="delete">Delete</button>
      </li>
    `
    )
    .join('');
  return `
    <div class="modal-backdrop" id="label-manager-backdrop">
      <div class="modal" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Labels</h2>
          <button type="button" class="ghost-btn small" id="close-label-manager">Close</button>
        </div>
        <ul class="label-list">${rows || '<li class="empty">No labels yet.</li>'}</ul>
        <form class="create-label" id="create-label-form">
          <input type="color" name="color" value="${DEFAULT_COLOR}" />
          <input type="text" name="name" maxlength="60" placeholder="New label name…" autocomplete="off" />
          <button type="submit">Add label</button>
        </form>
      </div>
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
        ${column.cards.filter(cardMatchesFilter).map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCardChips(card) {
  const cardLabels = card.labels || [];
  if (cardLabels.length === 0) return '';
  return `
    <div class="card-chips">
      ${cardLabels
        .map(
          (label) => `
        <span class="chip" style="background:${escapeHtml(label.color)}; color:${chipTextColor(label.color)}" title="${escapeHtml(label.name)}">
          ${escapeHtml(label.name)}
        </span>
      `
        )
        .join('')}
    </div>
  `;
}

function renderCardLabelMenu(card) {
  if (openCardMenuId !== card.id) return '';
  const assigned = new Set((card.labels || []).map((label) => label.id));
  const items = labels.length
    ? labels
        .map(
          (label) => `
        <label class="label-menu-item">
          <input type="checkbox" data-toggle-label="${escapeHtml(label.id)}" ${assigned.has(label.id) ? 'checked' : ''} />
          <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </label>
      `
        )
        .join('')
    : '<div class="label-menu-empty">No labels. Use “Manage labels”.</div>';
  return `<div class="label-menu">${items}</div>`;
}

function renderCard(card) {
  return `
    <article class="card${card.id === openCardMenuId ? ' menu-open' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}">
      <div class="card-top">
        <div class="card-text">${escapeHtml(card.text)}</div>
        <button type="button" class="card-label-btn" data-card-label-btn="${escapeHtml(card.id)}" title="Edit labels">🏷</button>
      </div>
      ${renderCardChips(card)}
      ${renderCardLabelMenu(card)}
    </article>
  `;
}

function chipTextColor(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1f2937' : '#ffffff';
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

  bindLabelEvents();
}

function bindLabelEvents() {
  const manageBtn = document.querySelector('#manage-labels');
  if (manageBtn) {
    manageBtn.addEventListener('click', () => {
      showLabelManager = true;
      render();
    });
  }

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

  document.querySelectorAll('[data-card-label-btn]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.cardLabelBtn;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });

  document.querySelectorAll('[data-toggle-label]').forEach((input) => {
    input.addEventListener('change', async () => {
      const cardEl = input.closest('.card');
      if (!cardEl) return;
      const cardId = cardEl.dataset.cardId;
      const labelId = input.dataset.toggleLabel;
      if (input.checked) await assignLabel(cardId, labelId);
      else await unassignLabel(cardId, labelId);
    });
  });

  // Prevent dragging from starting when interacting with the label menu.
  document.querySelectorAll('.label-menu').forEach((menu) => {
    menu.addEventListener('mousedown', (event) => event.stopPropagation());
  });

  bindLabelManagerEvents();
}

function bindLabelManagerEvents() {
  const backdrop = document.querySelector('#label-manager-backdrop');
  if (!backdrop) return;

  const close = () => {
    showLabelManager = false;
    render();
  };
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', close);

  const createForm = document.querySelector('#create-label-form');
  createForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = createForm.elements.name.value.trim();
    const color = createForm.elements.color.value;
    if (!name) return;
    await createLabel(name, color);
  });

  document.querySelectorAll('.label-row').forEach((row) => {
    const id = row.dataset.labelId;
    const nameInput = row.querySelector('[data-action="rename"]');
    const colorInput = row.querySelector('[data-action="recolor"]');
    const deleteBtn = row.querySelector('[data-action="delete"]');

    nameInput?.addEventListener('change', async () => {
      const name = nameInput.value.trim();
      const current = labelById(id);
      if (!name || (current && current.name === name)) {
        if (current) nameInput.value = current.name;
        return;
      }
      await updateLabel(id, { name });
    });
    colorInput?.addEventListener('change', async () => {
      await updateLabel(id, { color: colorInput.value });
    });
    deleteBtn?.addEventListener('click', async () => {
      await deleteLabel(id);
    });
  });
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create label failed');
    const createForm = document.querySelector('#create-label-form');
    if (createForm) createForm.elements.name.value = '';
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function updateLabel(id, patch) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update label failed');
  } catch (error) {
    setStatus(error.message, true);
    render();
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete label failed');
    activeFilter.delete(id);
  } catch (error) {
    setStatus(error.message, true);
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
    setStatus(error.message, true);
    await loadBoard();
    render();
  }
}

async function unassignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Unassign failed');
  } catch (error) {
    setStatus(error.message, true);
    await loadBoard();
    render();
  }
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
  if (Array.isArray(message.labels)) {
    labels = message.labels;
    // Drop any filter selections for labels that no longer exist.
    for (const id of [...activeFilter]) {
      if (!labelById(id)) activeFilter.delete(id);
    }
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    render();
    setStatus('Synced');
    return;
  }

  if (Array.isArray(message.labels) && !message.card) {
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
  const response = await fetch(`${API_BASE}/api/board`);
  if (!response.ok) throw new Error('Could not load board');
  board = normalizeBoard(await response.json());
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
    await Promise.all([loadBoard(), loadLabels()]);
    render();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
