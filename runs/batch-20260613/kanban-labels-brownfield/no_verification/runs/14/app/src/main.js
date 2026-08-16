import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set(); // label ids selected in the filter (client-side view state)
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;
let openLabelMenuCardId = null; // which card's "assign label" menu is open
let labelManagerOpen = false;

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

// A card is visible when no filter is active, or it carries at least one selected label.
function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabels = card.labels || [];
  return cardLabels.some((label) => activeFilter.has(label.id));
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
    ${renderToolbar()}
    ${labelManagerOpen ? renderLabelManager() : ''}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
  `;
  bindEvents();
}

function renderToolbar() {
  const chips = labels
    .map((label) => {
      const selected = activeFilter.has(label.id);
      return `
        <button
          type="button"
          class="filter-chip${selected ? ' selected' : ''}"
          data-filter-label-id="${escapeHtml(label.id)}"
          style="--chip-color: ${escapeHtml(label.color)}"
          aria-pressed="${selected}"
        >
          <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
          ${escapeHtml(label.name)}
        </button>`;
    })
    .join('');

  return `
    <section class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        ${labels.length ? chips : '<span class="filter-empty">No labels yet</span>'}
        ${activeFilter.size > 0 ? '<button type="button" class="clear-filter" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="toggle-label-manager">
        ${labelManagerOpen ? 'Close labels' : 'Manage labels'}
      </button>
    </section>
  `;
}

function renderLabelManager() {
  const rows = labels
    .map(
      (label) => `
      <li class="label-row" data-label-id="${escapeHtml(label.id)}">
        <form class="label-edit-form" data-label-id="${escapeHtml(label.id)}">
          <input type="color" class="label-color-input" value="${escapeHtml(toColorInput(label.color))}" />
          <input type="text" class="label-name-input" maxlength="100" value="${escapeHtml(label.name)}" />
          <button type="submit" class="label-save-btn">Save</button>
          <button type="button" class="label-delete-btn" data-label-id="${escapeHtml(label.id)}">Delete</button>
        </form>
      </li>`
    )
    .join('');

  return `
    <section class="label-manager">
      <h3>Labels</h3>
      <ul class="label-list">
        ${labels.length ? rows : '<li class="label-empty">No labels yet — create one below.</li>'}
      </ul>
      <form class="label-create-form" id="label-create-form">
        <input type="color" class="label-color-input" id="new-label-color" value="#2563eb" />
        <input type="text" class="label-name-input" id="new-label-name" maxlength="100" placeholder="New label name…" autocomplete="off" />
        <button type="submit">Create label</button>
      </form>
      <p class="label-error" id="label-error"></p>
    </section>
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
        ${column.cards.map(renderCard).join('')}
      </div>
    </section>
  `;
}

function renderCard(card) {
  const hidden = !cardMatchesFilter(card);
  const cardLabels = card.labels || [];
  const chips = cardLabels
    .map(
      (label) => `
      <span class="card-label-chip" style="background:${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
        <span class="chip-text">${escapeHtml(label.name)}</span>
        <button type="button" class="chip-remove" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}" title="Remove label" aria-label="Remove label">×</button>
      </span>`
    )
    .join('');

  return `
    <article class="card${hidden ? ' filtered-out' : ''}" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      <div class="card-text">${escapeHtml(card.text)}</div>
      ${cardLabels.length ? `<div class="card-labels">${chips}</div>` : ''}
      <div class="card-footer">
        <button type="button" class="add-label-btn" data-card-id="${escapeHtml(card.id)}">+ label</button>
      </div>
      ${openLabelMenuCardId === card.id ? renderLabelMenu(card) : ''}
    </article>
  `;
}

function renderLabelMenu(card) {
  const assigned = new Set((card.labels || []).map((l) => l.id));
  if (labels.length === 0) {
    return `<div class="label-menu"><p class="label-menu-empty">No labels. Use "Manage labels".</p></div>`;
  }
  const items = labels
    .map((label) => {
      const checked = assigned.has(label.id);
      return `
      <button type="button" class="label-menu-item${checked ? ' checked' : ''}" data-card-id="${escapeHtml(card.id)}" data-label-id="${escapeHtml(label.id)}">
        <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>
        <span class="label-menu-name">${escapeHtml(label.name)}</span>
        <span class="label-menu-check">${checked ? '✓' : ''}</span>
      </button>`;
    })
    .join('');
  return `<div class="label-menu">${items}</div>`;
}

// <input type="color"> only accepts 6-digit hex; expand 3-digit values for the picker.
function toColorInput(color) {
  if (/^#[0-9a-fA-F]{3}$/.test(color)) {
    return '#' + color.slice(1).split('').map((c) => c + c).join('');
  }
  return color;
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

  // Filter chips (client-side only — never mutate server state).
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

  const toggleManager = document.querySelector('#toggle-label-manager');
  if (toggleManager) {
    toggleManager.addEventListener('click', () => {
      labelManagerOpen = !labelManagerOpen;
      render();
    });
  }

  bindLabelManagerEvents();
  bindCardLabelEvents();

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

function bindLabelManagerEvents() {
  const createForm = document.querySelector('#label-create-form');
  if (createForm) {
    createForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const name = document.querySelector('#new-label-name').value.trim();
      const color = document.querySelector('#new-label-color').value;
      if (!name) {
        showLabelError('Label name is required');
        return;
      }
      const ok = await apiCreateLabel(name, color);
      if (ok) {
        const nameInput = document.querySelector('#new-label-name');
        if (nameInput) nameInput.value = '';
      }
    });
  }

  document.querySelectorAll('.label-edit-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = form.dataset.labelId;
      const name = form.querySelector('.label-name-input').value.trim();
      const color = form.querySelector('.label-color-input').value;
      if (!name) {
        showLabelError('Label name is required');
        return;
      }
      await apiUpdateLabel(id, name, color);
    });
  });

  document.querySelectorAll('.label-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.labelId;
      await apiDeleteLabel(id);
    });
  });
}

function bindCardLabelEvents() {
  document.querySelectorAll('.add-label-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      openLabelMenuCardId = openLabelMenuCardId === cardId ? null : cardId;
      render();
    });
  });

  document.querySelectorAll('.label-menu-item').forEach((item) => {
    item.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = item.dataset.cardId;
      const labelId = item.dataset.labelId;
      const checked = item.classList.contains('checked');
      if (checked) await apiUnassignLabel(cardId, labelId);
      else await apiAssignLabel(cardId, labelId);
    });
  });

  document.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const cardId = btn.dataset.cardId;
      const labelId = btn.dataset.labelId;
      await apiUnassignLabel(cardId, labelId);
    });
  });
}

function showLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message;
  else setStatus(message, true);
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

// ---- Label API calls (mutations broadcast back over SSE) ----

async function apiCreateLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    return true;
  } catch (error) {
    showLabelError(error.message);
    return false;
  }
}

async function apiUpdateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    return true;
  } catch (error) {
    showLabelError(error.message);
    return false;
  }
}

async function apiDeleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Delete failed');
    activeFilter.delete(id);
    return true;
  } catch (error) {
    showLabelError(error.message);
    return false;
  }
}

async function apiAssignLabel(cardId, labelId) {
  try {
    const response = await fetch(`${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labelId }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Assign failed');
    return true;
  } catch (error) {
    setStatus(`Assign failed: ${error.message}`, true);
    return false;
  }
}

async function apiUnassignLabel(cardId, labelId) {
  try {
    const response = await fetch(
      `${API_BASE}/api/cards/${encodeURIComponent(cardId)}/labels/${encodeURIComponent(labelId)}`,
      { method: 'DELETE' }
    );
    if (!response.ok) throw new Error((await response.json()).error || 'Remove failed');
    return true;
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, true);
    return false;
  }
}

function applyMutation(message) {
  // Label collection changes ride along with most label mutations.
  if (Array.isArray(message.labels)) {
    labels = message.labels;
  }

  if (message.board) {
    board = normalizeBoard(message.board);
    pruneFilter();
    render();
    setStatus('Synced');
    return;
  }

  if (!message.card) {
    // Pure label-create with no board payload — still need a re-render.
    render();
    setStatus('Synced');
    return;
  }

  const card = { ...message.card, labels: message.card.labels || [] };
  removeCardEverywhere(card.id);
  const target = board.columns.find((column) => column.id === card.column_id || column.id === message.columnId);
  if (!target) return;
  target.cards.push(card);
  target.cards.sort(compareCards);
  render();
  setStatus('Synced');
}

// Drop filter selections that no longer reference an existing label.
function pruneFilter() {
  const ids = new Set(labels.map((l) => l.id));
  for (const id of [...activeFilter]) {
    if (!ids.has(id)) activeFilter.delete(id);
  }
}

async function loadBoard() {
  const [boardResponse, labelsResponse] = await Promise.all([
    fetch(`${API_BASE}/api/board`),
    fetch(`${API_BASE}/api/labels`),
  ]);
  if (!boardResponse.ok) throw new Error('Could not load board');
  board = normalizeBoard(await boardResponse.json());
  if (labelsResponse.ok) {
    labels = await labelsResponse.json();
  }
  pruneFilter();
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
