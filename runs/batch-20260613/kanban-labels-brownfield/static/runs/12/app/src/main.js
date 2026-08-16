import './style.css';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3001';
const app = document.querySelector('#app');

let board = { columns: [] };
let labels = [];
let activeFilter = new Set();
let labelManagerOpen = false;
let openCardMenuId = null;
let draggedCardId = null;
let eventSource = null;
let statusTimer = null;

const DEFAULT_LABEL_COLOR = '#2563eb';

function labelById(id) {
  return labels.find((label) => label.id === id) || null;
}

function cardMatchesFilter(card) {
  if (activeFilter.size === 0) return true;
  const cardLabelIds = (card.labels || []).map((label) => label.id);
  return cardLabelIds.some((id) => activeFilter.has(id));
}

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
      <div id="status" class="status">Connecting…</div>
    </header>
    ${renderToolbar()}
    <main class="board">
      ${board.columns.map(renderColumn).join('')}
    </main>
    ${labelManagerOpen ? renderLabelManager() : ''}
  `;
  bindEvents();
  bindLabelEvents();
}

function renderToolbar() {
  return `
    <div class="toolbar">
      <div class="filter-bar">
        <span class="filter-label">Filter:</span>
        ${labels.length === 0 ? '<span class="filter-empty">No labels yet</span>' : ''}
        ${labels
          .map(
            (label) => `
          <button
            type="button"
            class="filter-chip${activeFilter.has(label.id) ? ' active' : ''}"
            data-filter-label-id="${escapeHtml(label.id)}"
            style="--chip-color: ${escapeHtml(label.color)}"
            title="Toggle filter by ${escapeHtml(label.name)}"
          >${escapeHtml(label.name)}</button>`
          )
          .join('')}
        ${activeFilter.size > 0 ? '<button type="button" class="filter-clear" id="clear-filter">Clear filter</button>' : ''}
      </div>
      <button type="button" class="manage-labels-btn" id="manage-labels">Manage labels</button>
    </div>
  `;
}

function renderLabelManager() {
  return `
    <div class="modal-overlay" id="label-manager-overlay">
      <div class="modal label-manager" role="dialog" aria-label="Manage labels">
        <div class="modal-header">
          <h2>Manage labels</h2>
          <button type="button" class="modal-close" id="close-label-manager" aria-label="Close">×</button>
        </div>
        <ul class="label-list">
          ${labels.length === 0 ? '<li class="label-list-empty">No labels yet. Create one below.</li>' : ''}
          ${labels
            .map(
              (label) => `
            <li class="label-row" data-label-id="${escapeHtml(label.id)}">
              <input type="color" class="label-color-input" value="${escapeHtml(toColorInputValue(label.color))}" data-label-color-id="${escapeHtml(label.id)}" title="Recolor" />
              <input type="text" class="label-name-input" value="${escapeHtml(label.name)}" maxlength="100" data-label-name-id="${escapeHtml(label.id)}" />
              <button type="button" class="label-save" data-save-label-id="${escapeHtml(label.id)}">Save</button>
              <button type="button" class="label-delete" data-delete-label-id="${escapeHtml(label.id)}">Delete</button>
            </li>`
            )
            .join('')}
        </ul>
        <form class="label-create-form" id="label-create-form">
          <input type="color" name="color" value="${DEFAULT_LABEL_COLOR}" title="Pick color" />
          <input type="text" name="name" maxlength="100" placeholder="New label name…" autocomplete="off" />
          <button type="submit">Create label</button>
        </form>
        <p class="label-error" id="label-error"></p>
      </div>
    </div>
  `;
}

function toColorInputValue(color) {
  if (typeof color !== 'string') return DEFAULT_LABEL_COLOR;
  let value = color.trim();
  if (/^#[0-9a-fA-F]{3}$/.test(value)) {
    value = '#' + value.slice(1).split('').map((c) => c + c).join('');
  }
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_LABEL_COLOR;
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

function renderCard(card) {
  const cardLabels = card.labels || [];
  const assignedIds = new Set(cardLabels.map((label) => label.id));
  const available = labels.filter((label) => !assignedIds.has(label.id));
  const menuOpen = openCardMenuId === card.id;
  return `
    <article class="card" draggable="true" data-card-id="${escapeHtml(card.id)}" title="Drag to move">
      ${cardLabels.length
        ? `<div class="card-chips">${cardLabels
            .map(
              (label) => `
        <span class="chip" style="--chip-color: ${escapeHtml(label.color)}" title="${escapeHtml(label.name)}">
          <span class="chip-name">${escapeHtml(label.name)}</span>
          <button type="button" draggable="false" class="chip-remove" data-remove-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}" title="Remove label" aria-label="Remove label">×</button>
        </span>`
            )
            .join('')}</div>`
        : ''}
      <div class="card-text">${escapeHtml(card.text)}</div>
      <div class="card-label-actions">
        <button type="button" draggable="false" class="add-label-btn" data-add-label-card="${escapeHtml(card.id)}" title="Add a label">+ Label</button>
        ${menuOpen
          ? `<div class="label-menu" data-label-menu-card="${escapeHtml(card.id)}">
              ${labels.length === 0 ? '<div class="label-menu-empty">No labels. Create some first.</div>' : ''}
              ${available.length === 0 && labels.length > 0 ? '<div class="label-menu-empty">All labels assigned.</div>' : ''}
              ${available
                .map(
                  (label) => `
              <button type="button" class="label-menu-item" data-assign-label="${escapeHtml(label.id)}" data-card-id="${escapeHtml(card.id)}">
                <span class="chip-dot" style="background:${escapeHtml(label.color)}"></span>${escapeHtml(label.name)}
              </button>`
                )
                .join('')}
            </div>`
          : ''}
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
  if (message.type && message.type.startsWith('label-')) {
    applyLabelMutation(message);
  }

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
  switch (message.type) {
    case 'label-create':
      if (message.label && !labelById(message.label.id)) labels.push(message.label);
      break;
    case 'label-update':
      if (message.label) {
        const idx = labels.findIndex((l) => l.id === message.label.id);
        if (idx !== -1) labels[idx] = message.label;
        else labels.push(message.label);
      }
      break;
    case 'label-delete':
      labels = labels.filter((l) => l.id !== message.labelId);
      activeFilter.delete(message.labelId);
      break;
    default:
      break;
  }
  labels.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function bindLabelEvents() {
  // Toolbar: filter toggles
  document.querySelectorAll('[data-filter-label-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.filterLabelId;
      if (activeFilter.has(id)) activeFilter.delete(id);
      else activeFilter.add(id);
      render();
    });
  });
  document.querySelector('#clear-filter')?.addEventListener('click', () => {
    activeFilter.clear();
    render();
  });

  // Manage labels modal
  document.querySelector('#manage-labels')?.addEventListener('click', () => {
    labelManagerOpen = true;
    render();
  });
  document.querySelector('#close-label-manager')?.addEventListener('click', closeLabelManager);
  document.querySelector('#label-manager-overlay')?.addEventListener('click', (event) => {
    if (event.target.id === 'label-manager-overlay') closeLabelManager();
  });

  document.querySelector('#label-create-form')?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = event.target.elements.name.value;
    const color = event.target.elements.color.value;
    await createLabel(name, color);
  });

  document.querySelectorAll('[data-save-label-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.saveLabelId;
      const name = document.querySelector(`[data-label-name-id="${cssEscape(id)}"]`)?.value;
      const color = document.querySelector(`[data-label-color-id="${cssEscape(id)}"]`)?.value;
      await updateLabel(id, name, color);
    });
  });

  document.querySelectorAll('[data-delete-label-id]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await deleteLabel(btn.dataset.deleteLabelId);
    });
  });

  // Card: add label menu toggle
  document.querySelectorAll('[data-add-label-card]').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      const id = btn.dataset.addLabelCard;
      openCardMenuId = openCardMenuId === id ? null : id;
      render();
    });
  });

  // Card: assign a label
  document.querySelectorAll('[data-assign-label]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      openCardMenuId = null;
      await assignLabel(btn.dataset.cardId, btn.dataset.assignLabel);
    });
  });

  // Card: remove a label chip
  document.querySelectorAll('[data-remove-label]').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.stopPropagation());
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      await unassignLabel(btn.dataset.cardId, btn.dataset.removeLabel);
    });
  });

  // Close card label menu when clicking elsewhere
  if (openCardMenuId) {
    const handler = (event) => {
      if (!event.target.closest('.card-label-actions')) {
        openCardMenuId = null;
        document.removeEventListener('click', handler);
        render();
      }
    };
    setTimeout(() => document.addEventListener('click', handler), 0);
  }
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function closeLabelManager() {
  labelManagerOpen = false;
  render();
}

function showLabelError(message) {
  const el = document.querySelector('#label-error');
  if (el) el.textContent = message || '';
}

async function createLabel(name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Create failed');
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
  }
}

async function updateLabel(id, name, color) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, color }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'Update failed');
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
  }
}

async function deleteLabel(id) {
  try {
    const response = await fetch(`${API_BASE}/api/labels/${id}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 204) {
      throw new Error((await response.json()).error || 'Delete failed');
    }
    activeFilter.delete(id);
    showLabelError('');
  } catch (error) {
    showLabelError(error.message);
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
    const response = await fetch(`${API_BASE}/api/cards/${cardId}/labels/${labelId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error((await response.json()).error || 'Remove failed');
  } catch (error) {
    setStatus(`Remove failed: ${error.message}`, true);
  }
}

async function loadLabels() {
  const response = await fetch(`${API_BASE}/api/labels`);
  if (!response.ok) throw new Error('Could not load labels');
  labels = await response.json();
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
    await loadLabels();
    await loadBoard();
    connectStream();
  } catch (error) {
    app.innerHTML = `<div class="loading error">${escapeHtml(error.message)}</div>`;
  }
}

start();
